// Transcript cursor: entries feed the transcript. The queue-state cursor
// (chat_reconciliation_cursors) is separate and lives in recovery.ts.
// coherence:seam owner=@maintainer until=2027-01-31 reason="durable log and platform tables retire at different times"

import type { Conversation, EntryId, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { BridgeDeps } from "./bridge.js";
import { canonicalJson } from "../platform/domain/json.js";
import {
  assistantMessageEvent,
  compactionEvent,
  toolResultEvent,
  unwrapCompactionSummary,
  userMessageEvent,
  type Block,
  type ThreadEvent,
  type ThreadEventRow,
} from "../platform/domain/thread-events.js";
import { artifactMeta, shouldSpill, spillOversizedResult } from "./spill.js";
import { AGENT_MESSAGE_KIND, agentMessageOf } from "./agent-message.js";
import { CHILD_RESULT_KIND, childResultOf } from "./child-result.js";
import { MEMBER_MESSAGE_KIND, memberMessageOf } from "./member-message.js";
import { POSTED_TURN_KIND, postedTurnText } from "./posted-turn.js";
import { NOTICE_KIND, noticeEventOf } from "./notice.js";

export interface ProjectionState {
  chatId: string;
  orgId: string;
  turn: number;
  step: number;
  currentModel: string | null;
  /** Last appended assistant row id (the stop epilogue's Done message_id). */
  lastEventId: string | null;
  /** Spilled pointer text per tool call id (the ToolCompleted stream card
   *  carries the pointer). */
  spilled: Map<string, string>;
  legacyThrough?: number;
}

/** Durable transcript translation and backfill; never emits socket frames. */
export class TranscriptProjection {
  constructor(private readonly deps: BridgeDeps) {}
  /** Backfill from immutable storage, including entries outside the active
   * reset/compaction range. Each projected row is idempotent before its
   * cursor advances, so a process may die between those two commits. */
  async recover(
    conversation: Conversation,
    bound: ProjectionState,
    submissions: readonly SubmissionRecord[] = [],
    through?: EntryId,
  ): Promise<void> {
    const cursor = await this.deps.threads.projectionCursor(bound.chatId, Number(conversation.id));
    if (cursor.legacyThrough === undefined) {
      cursor.legacyThrough = Number(
        through ??
          (await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ??
          0,
      );
      await this.deps.threads.advanceProjection(bound.chatId, Number(conversation.id), cursor);
    }
    const placed = new Map(submissions.filter((s) => s.entry !== undefined).map((s) => [Number(s.entry), s]));
    const answers = new Set(
      submissions.flatMap((s) => (s.type === "input" && s.status === "done" ? [Number(s.answer)] : [])),
    );
    const replay: ProjectionState = {
      ...bound,
      turn: cursor.turn,
      step: cursor.step,
      legacyThrough: cursor.legacyThrough,
      spilled: new Map(),
    };
    for (;;) {
      const page = await conversation.entries(
        {
          order: "ascending",
          minEntryId: (cursor.entryId + 1) as EntryId,
          ...(through === undefined ? {} : { maxEntryId: through }),
        },
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );
      if (page.items.length === 0) break;
      for (const entry of page.items) {
        const input = placed.get(Number(entry.id));
        if ((entry.kind === "pi.user" || input?.type === "input") && !cursor.runOpen) {
          replay.turn++;
          replay.step = 0;
          cursor.runOpen = true;
        }
        await this.project(replay, entry);
        const answer = entry.kind === "pi.assistant" ? entry.model?.find((m) => m.role === "assistant") : undefined;
        if (
          answer?.role === "assistant" &&
          (answers.has(Number(entry.id)) ||
            answer.stopReason !== "toolUse" ||
            !answer.content.some((b) => b.type === "toolCall"))
        ) {
          cursor.runOpen = false;
        }
        cursor.entryId = Number(entry.id);
        cursor.turn = replay.turn;
        cursor.step = replay.step;
      }
      await this.deps.threads.advanceProjection(bound.chatId, Number(conversation.id), cursor);
    }
  }

  async project(state: ProjectionState, entry: EntryRecord): Promise<void> {
    switch (entry.kind) {
      case "pi.user":
        // A member's message is a guild.member-message entry. A plain user
        // entry is history whose row was written when it was sent.
        return;
      case "pi.assistant": {
        const message = entry.model?.find((m) => m.role === "assistant");
        if (message?.role !== "assistant") return;
        state.step += 1;
        state.currentModel = message.model;
        const blocks: Block[] = [];
        let text = "";
        let reasoning = "";
        const toolCalls: { id: string; name: string; arguments: string }[] = [];
        for (const block of message.content) {
          if (block.type === "text") text += block.text;
          else if (block.type === "thinking") reasoning += block.thinking;
          else if (block.type === "toolCall") {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: canonicalJson(block.arguments),
            });
          }
        }
        if (reasoning !== "") blocks.push({ type: "reasoning", text: reasoning });
        if (text !== "") blocks.push({ type: "text", text });
        for (const call of toolCalls) blocks.push({ type: "tool_call", ...call });
        const usage = {
          tokens_in: message.usage.input,
          tokens_out: message.usage.output,
          cost_usd: message.usage.cost.total,
        };
        const attachments =
          toolCalls.length === 0 && this.deps.agentFiles !== undefined
            ? await this.deps.agentFiles.pending(state.chatId)
            : [];
        const ev = assistantMessageEvent(
          state.turn,
          state.step,
          blocks,
          usage,
          message.model,
          message.stopReason === "aborted" ? true : undefined,
          message.stopReason === "error" ? (message.errorMessage ?? "Model error") : undefined,
          attachments,
        );
        const row = await this.append(state, entry, ev);
        state.lastEventId = row.id;
        if (row.event.type === "assistant_message") {
          state.turn = row.event.turn;
          state.step = row.event.step;
        }
        return;
      }
      case "pi.tool-result": {
        const result = entry.model?.find((m) => m.role === "toolResult");
        if (result?.role !== "toolResult") return;
        const content = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
        // The tool-owned widget payload rides the result details' reserved
        // `guild_meta` key (integration tools, spec C.2); other tools carry
        // no meta, so the wire contract stays untouched for them.
        // Codemode is the other meta-carrying tool: pi-durable writes the
        // script's nested-call list into the result details once, with the
        // result, and that list is the desktop widget's payload (the nested
        // tool_execution frames are dropped above).
        const details = result.details;
        const isCodemode = result.toolName === "codemode";
        const codemodeMeta =
          isCodemode && details !== null && typeof details === "object" && !Array.isArray(details)
            ? details
            : undefined;
        const toolMeta =
          codemodeMeta ??
          (details !== null && typeof details === "object" && !Array.isArray(details)
            ? (details as Record<string, unknown>)["guild_meta"]
            : undefined);
        // Image parts ride only when the route supports the image modality
        // (gated at persist time, so replay stays identical).
        const supported = await this.deps.routeSupportsImages(state.orgId, state.currentModel);
        const eventImages = supported
          ? result.content
              .filter((part): part is { type: "image"; data: string; mimeType: string } => part.type === "image")
              .map((part) => `data:${part.mimeType};base64,${part.data}`)
          : [];
        const ev = toolResultEvent(
          state.turn,
          state.step,
          result.toolCallId,
          result.toolName,
          content,
          result.isError,
          toolMeta,
        );
        if (eventImages.length > 0) (ev as { images: string[] }).images = eventImages;
        // Oversized-result spill: the persisted event carries the pointer
        // text + the artifact card meta; the durable entry keeps the full
        // content (pi-durable owns model context).
        if (this.deps.spill !== undefined && shouldSpill(content)) {
          try {
            const { spilled, pointer } = await spillOversizedResult(
              this.deps.spill.artifacts,
              this.deps.spill.objects,
              state.orgId,
              state.chatId,
              result.toolCallId,
              result.toolName,
              content,
            );
            state.spilled.set(result.toolCallId, pointer);
            (ev as { content: string }).content = pointer;
            // The spilled card claims the meta (existing tool meta keys
            // preserved).
            const meta = artifactMeta(toolMeta, spilled);
            (ev as { meta?: unknown }).meta = meta;
          } catch (error) {
            this.deps.log.error({ err: error, chatId: state.chatId }, "oversized result spill failed, keeping inline");
          }
        }
        await this.append(state, entry, ev);
        return;
      }
      case AGENT_MESSAGE_KIND: {
        // A posted message is its own turn, after every turn the chat has.
        const message = agentMessageOf(entry);
        if (message === null) return;
        const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
        const turn = Math.max(state.turn, await this.deps.threads.latestTurn(state.chatId)) + 1;
        const ev = assistantMessageEvent(
          turn,
          1,
          [{ type: "text", text }],
          { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
          message.model,
        );
        const row = await this.append(state, entry, ev);
        if (row.event.type === "assistant_message") {
          state.turn = row.event.turn;
          state.step = 0;
          await this.deps.agentRuns?.postedMessage(state.chatId, row);
        }
        return;
      }
      case NOTICE_KIND: {
        const event = noticeEventOf(entry);
        if (event !== null) await this.append(state, entry, event);
        return;
      }
      case POSTED_TURN_KIND: {
        // A posted turn shows from its placement on.
        const text = postedTurnText(entry);
        if (text !== null) await this.append(state, entry, userMessageEvent(text));
        return;
      }
      case CHILD_RESULT_KIND: {
        // The parent has the result from this entry on, so its card shows
        // here, at the placement position.
        const event = childResultOf(entry);
        if (event !== null) await this.append(state, entry, event);
        return;
      }
      case MEMBER_MESSAGE_KIND: {
        // The member's message shows from its placement on, under its
        // message id (the id the sender's optimistic block waits for).
        const message = memberMessageOf(entry);
        if (message === null) return;
        await this.append(state, entry, userMessageEvent(message.text, message.attachments), message.message_id);
        return;
      }
      case "pi.compaction": {
        // pi-durable compactions carry the summary as text blocks; the
        // importer's synthetic ones carry a plain string.
        const summary = entry.model?.find((m) => m.role === "user");
        const raw = summary?.content;
        const text =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw.map((b) => (b.type === "text" ? b.text : "")).join("")
              : "";
        const ev = compactionEvent(unwrapCompactionSummary(text));
        await this.append(state, entry, ev);
        return;
      }
      default:
        return;
    }
  }

  private append(state: ProjectionState, entry: EntryRecord, event: ThreadEvent, id?: string): Promise<ThreadEventRow> {
    return this.deps.threads.appendProjectedEntry({
      chatId: state.chatId,
      entryId: Number(entry.id),
      event,
      adoptLegacy: Number(entry.id) <= (state.legacyThrough ?? -1),
      ...(id === undefined ? {} : { id }),
    });
  }
}
