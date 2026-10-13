// The event bridge: pi-durable `watchEvents()` streams → thread_events rows
// + generating flag + turn-command settlement, with the EXACT frame contract
// the Rust ChatRunner wrote (turn/step numbering, UsagePayload fields,
// serde-ordered wire rows — see platform/domain/thread-events.ts).
//
// Turn semantics: one Guild turn = one client request = one pi-durable run
// (turn number derived from the log at each run_start, so restarts cannot
// drift); steered inputs join the running turn, follow-ups start the next.
// Steps count model calls within the turn, exactly like the ChatRunner.

import type { AgentEvent } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Logger } from "pino";
import type { StreamWireEvent } from "../hub/protocol.js";
import { uuidv7 } from "../platform/time.js";
import type { ObjectStore } from "../platform/s3.js";
import type { ToolArtifactStore } from "../platform/store/toolArtifacts.js";
import { artifactMeta, shouldSpill, spillOversizedResult } from "./spill.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { ThreadStore } from "../platform/store/thread.js";
import type { TurnCommandStore } from "../platform/store/turn_commands.js";
import {
  assistantMessageEvent,
  compactionEvent,
  toolResultEvent,
  unwrapCompactionSummary,
  type Block,
  type ThreadEvent,
  type ThreadEventRow,
} from "../platform/domain/thread-events.js";

export interface LiveBuffers {
  /** Unpersisted streaming buffers of the current generation attempt (the
   *  ThreadState frame's text/thinking fields; empty when idle). */
  text: string;
  thinking: string;
}

/** The live generation fan-out the member-socket feed implements: the
 *  bridge's model deltas and terminals leave the process as live_frame
 *  frames (Rust: state.generations broadcast + feed::drain_events). */
export interface GenerationStreamSink {
  /** Registers the chat's active generation identity — the command id the
   *  turn ack carries as generation_id (Rust attach_with_id). Untracked
   *  runs keep an already-open identity (Rust attach semantics). */
  open(chatId: string, generationId: string): void;
  /** One StreamEvent inside the chat's open generation. */
  event(chatId: string, event: StreamWireEvent): void;
  /** The chat's streaming buffers moved — the feed's view republish poll
   *  must capture (Rust publish_views' signature tick). */
  dirty(chatId: string): void;
  /** The generation ended (Rust generations.remove). */
  close(chatId: string): void;
}

export interface BridgeDeps {
  threads: ThreadStore;
  chats: ChatStore;
  turnCommands: TurnCommandStore;
  /** The resolved route's image-modality support for the conversation's
   *  current model (gates tool-result image parts at persist time, like the
   *  Rust persist path). */
  routeSupportsImages(orgId: string, model: string | null): Promise<boolean>;
  /** Spill machinery (M4): oversized tool results become artifacts. Absent
   *  (tests without an object store) = no spill, inline results only. */
  spill?: { artifacts: ToolArtifactStore; objects: ObjectStore };
  log: Logger;
}

interface BridgeState {
  chatId: string;
  orgId: string;
  turn: number;
  step: number;
  handledEntries: Set<string>;
  currentModel: string | null;
  buffers: LiveBuffers;
  /** The open generation's identity (live_frame generation_id) — the run's
   *  originating command id; null until a run starts. */
  generationId: string | null;
  /** One terminal (Done/Error) per generation: sent or already impossible. */
  doneSent: boolean;
  /** The run's failure message (pi.generation task_failed) — Error terminal
   *  at run end. */
  failure: string | null;
  /** Last appended assistant row id (the stop epilogue's Done message_id). */
  lastEventId: string | null;
  /** Spilled pointer text per tool call id (the ToolCompleted stream card
   *  carries the pointer, like the Rust post-spill payload). */
  spilled: Map<string, string>;
}

function invocationOf(submissionId: number): string {
  return `sub:${submissionId}`;
}

export class ChatBridge {
  private readonly states = new Map<string, BridgeState>();
  private streamSink: GenerationStreamSink | null = null;

  constructor(private readonly deps: BridgeDeps) {}

  /** Wires the live-frame fan-out (the feed forwarder; unset = frames are
   *  dropped — sinks-less deployments still persist everything). */
  setStream(sink: GenerationStreamSink | null): void {
    this.streamSink = sink;
  }

  state(conversationId: string): BridgeState {
    let state = this.states.get(conversationId);
    if (!state) {
      state = {
        chatId: "",
        orgId: "",
        turn: 0,
        step: 0,
        handledEntries: new Set(),
        currentModel: null,
        buffers: { text: "", thinking: "" },
        generationId: null,
        doneSent: false,
        failure: null,
        lastEventId: null,
        spilled: new Map(),
      };
      this.states.set(conversationId, state);
    }
    return state;
  }

  /** Registers the chat/org identity of a watched conversation. */
  bind(conversationId: string, chatId: string, orgId: string): void {
    const state = this.state(conversationId);
    state.chatId = chatId;
    state.orgId = orgId;
  }

  forget(conversationId: string): void {
    this.states.delete(conversationId);
  }

  buffers(conversationId: string): LiveBuffers {
    return this.state(conversationId).buffers;
  }

  /** Handles one watchEvents batch. Never throws: a bridge failure must not
   *  kill the durable run — errors are logged and the durable entries stay
   *  the source of truth (re-runnable recovery = importer rerun). */
  handle = async (conversationId: string, events: readonly AgentEvent[]): Promise<void> => {
    const state = this.state(conversationId);
    if (!state.chatId) return;
    for (const event of events) {
      try {
        await this.handleOne(conversationId, state, event);
      } catch (error) {
        this.deps.log.error({ err: error, chatId: state.chatId, event: event.type }, "bridge event failed");
      }
    }
  };

  private async handleOne(_conversationId: string, state: BridgeState, event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "run_start": {
        state.turn = (await this.deps.threads.latestTurn(state.chatId)) + 1;
        state.step = 0;
        state.doneSent = false;
        state.failure = null;
        state.lastEventId = null;
        await this.deps.chats.setGenerating(state.orgId, state.chatId, true);
        let generationId: string | null = null;
        let oldestPosition: number | null = null;
        for (const input of event.inputs) {
          const commands = await this.deps.turnCommands.byInvocation(invocationOf(Number(input)));
          for (const command of commands) {
            const claimed = await this.deps.turnCommands.begin(command.id, state.chatId, invocationOf(Number(input)));
            void claimed;
            if (generationId === null || (command.position !== null && command.position < (oldestPosition ?? Number.MAX_SAFE_INTEGER))) {
              generationId = command.id;
              oldestPosition = command.position;
            }
          }
        }
        // Untracked runs keep an already-open generation identity (Rust
        // attach semantics); a cold untracked run streams under a fresh id
        // no client matches, exactly like Rust's fresh attach.
        state.generationId = generationId ?? state.generationId ?? uuidv7();
        if (this.streamSink && state.chatId) this.streamSink.open(state.chatId, state.generationId);
        return;
      }
      case "run_end": {
        await this.deps.chats.setGenerating(state.orgId, state.chatId, false);
        for (const input of event.inputs) {
          const commands = await this.deps.turnCommands.byInvocation(invocationOf(Number(input)));
          for (const command of commands) {
            await this.deps.turnCommands.finish(command.id, invocationOf(Number(input)), false);
          }
        }
        this.finishGeneration(state);
        return;
      }
      case "task_failed": {
        // The run's own failure (Rust: StreamEvent::Error at the failure
        // point + the registry removal). Tool/compaction task failures are
        // the executor paths' own surface.
        if (event.kind !== "pi.generation" || state.generationId === null || state.doneSent) return;
        state.doneSent = true;
        state.failure = event.message;
        this.emitStream(state, { type: "error", code: "provider", message: event.message });
        return;
      }
      case "message_start": {
        state.buffers.text = "";
        state.buffers.thinking = "";
        if (event.message.role === "assistant") {
          state.currentModel = (event.message as { model?: string }).model ?? state.currentModel;
          // The first partial commit arrives as message_start with the
          // content streamed so far (Rust: the first ProviderChunk::Text
          // already emits its Delta) — seed the buffers and stream it.
          let moved = false;
          for (const block of (event.message as { content: { type: string; text?: string; thinking?: string }[] }).content) {
            if (block.type === "text" && block.text) {
              state.buffers.text += block.text;
              this.emitStream(state, { type: "delta", content: block.text });
              moved = true;
            } else if (block.type === "thinking" && block.thinking) {
              state.buffers.thinking += block.thinking;
              this.emitStream(state, { type: "thinking_delta", content: block.thinking });
              moved = true;
            }
          }
          if (moved && this.streamSink && state.chatId) this.streamSink.dirty(state.chatId);
        }
        return;
      }
      case "message_update": {
        let moved = false;
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            state.buffers.text += change.delta;
            this.emitStream(state, { type: "delta", content: change.delta });
            moved = true;
          } else if (change.type === "thinking_delta") {
            state.buffers.thinking += change.delta;
            this.emitStream(state, { type: "thinking_delta", content: change.delta });
            moved = true;
          } else if (change.type === "text_start") {
            // A block inserted whole holds its text so far (the first chunk
            // of the block rides the insert).
            const block = change.block as { text?: string };
            state.buffers.text += block.text ?? "";
            if (block.text) this.emitStream(state, { type: "delta", content: block.text });
            moved = true;
          } else if (change.type === "thinking_start") {
            const block = change.block as { thinking?: string };
            state.buffers.thinking += block.thinking ?? "";
            if (block.thinking) this.emitStream(state, { type: "thinking_delta", content: block.thinking });
            moved = true;
          } else if (change.type === "block" && change.block.type === "text") {
            state.buffers.text += change.block.text;
            this.emitStream(state, { type: "delta", content: change.block.text });
            moved = true;
          } else if (change.type === "block" && change.block.type === "thinking") {
            state.buffers.thinking += change.block.thinking;
            this.emitStream(state, { type: "thinking_delta", content: change.block.thinking });
            moved = true;
          } else if (change.type === "message") {
            // The whole partial was replaced: resync the buffers (the stream
            // frames already delivered the prefix; the view poll corrects).
            state.buffers.text = "";
            state.buffers.thinking = "";
            for (const block of (change.message as { content: { type: string; text?: string; thinking?: string }[] }).content) {
              if (block.type === "text") state.buffers.text += block.text ?? "";
              else if (block.type === "thinking") state.buffers.thinking += block.thinking ?? "";
            }
            moved = true;
          }
        }
        if (moved && this.streamSink && state.chatId) this.streamSink.dirty(state.chatId);
        return;
      }
      case "message_end": {
        state.buffers.text = "";
        state.buffers.thinking = "";
        // The finalized entry rides the event (assistant messages; tool
        // results arrive via tool_execution_end). entry_appended events do
        // not repeat run-generated entries.
        if (event.entry && !state.handledEntries.has(String(event.entry.id))) {
          state.handledEntries.add(String(event.entry.id));
          await this.handleEntry(state, event.entry);
        }
        return;
      }
      case "tool_execution_start": {
        // The tool-call card (Rust: ToolStarted into the generation stream;
        // the durable harness's tools execute server-side).
        if (state.generationId === null) return;
        this.emitStream(state, {
          type: "tool_started",
          call_id: event.toolCallId,
          name: event.toolName,
          arguments: canonicalJson(event.args),
          executor: "server",
        });
        return;
      }
      case "tool_execution_end": {
        if (event.entry && !state.handledEntries.has(String(event.entry.id))) {
          state.handledEntries.add(String(event.entry.id));
          const result = event.entry.model?.find((m) => m.role === "toolResult");
          await this.handleEntry(state, event.entry);
          // The result card rides after the persisted row (Rust
          // ToolCompleted carries the finished tool's content — the spilled
          // pointer when the result spilled).
          if (result && result.role === "toolResult" && state.generationId !== null) {
            const raw = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
            this.emitStream(state, {
              type: "tool_completed",
              call_id: result.toolCallId,
              name: result.toolName,
              content: state.spilled.get(result.toolCallId) ?? raw,
              is_error: result.isError,
            });
          }
        }
        return;
      }
      case "entry_appended": {
        if (state.handledEntries.has(String(event.entry.id))) return;
        state.handledEntries.add(String(event.entry.id));
        await this.handleEntry(state, event.entry);
        return;
      }
      case "submission": {
        // Settled-but-unanswered inputs (stop / archive withdrawal): mark
        // cancelled so no waiting head wedges the chat.
        if (event.record.status === "unanswered") {
          const commands = await this.deps.turnCommands.byInvocation(invocationOf(Number(event.record.id)));
          for (const command of commands) {
            await this.deps.turnCommands.settleCancelled(command.id, invocationOf(Number(event.record.id)));
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleEntry(state: BridgeState, entry: EntryRecord): Promise<void> {
    switch (entry.kind) {
      case "pi.user":
        // The visible user echo is written by the accept path
        // (turn_commands.accept, id = user_message_id) — never duplicated.
        return;
      case "pi.assistant": {
        const message = entry.model?.find((m) => m.role === "assistant");
        if (!message || message.role !== "assistant") return;
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
        const ev = assistantMessageEvent(
          state.turn,
          state.step,
          blocks,
          usage,
          message.model,
          message.stopReason === "aborted" ? true : undefined,
        );
        const row = await this.append(state, ev);
        state.lastEventId = row.id;
        if (this.streamSink && state.chatId && state.generationId !== null) {
          if (message.stopReason === "aborted") {
            // The stop epilogue owns this generation's terminal: a
            // zero-usage Done at run end (Rust's cancelled path).
          } else if (toolCalls.length === 0) {
            // The final step: the turn ends — Rust sends Done inline at the
            // final persist (route-priced usage).
            state.doneSent = true;
            this.emitStream(state, {
              type: "done",
              message_id: row.id,
              cost_usd: usage.cost_usd ?? 0,
              tokens_in: usage.tokens_in ?? 0,
              tokens_out: usage.tokens_out ?? 0,
            });
          }
        }
        return;
      }
      case "pi.tool-result": {
        const result = entry.model?.find((m) => m.role === "toolResult");
        if (!result || result.role !== "toolResult") return;
        const content = result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        // The tool-owned widget payload rides the result details' reserved
        // `guild_meta` key (integration tools, spec C.2); other tools carry
        // no meta, so the wire contract stays untouched for them.
        const details = result.details;
        const toolMeta = details !== null && typeof details === "object" && !Array.isArray(details)
          ? (details as Record<string, unknown>)["guild_meta"]
          : undefined;
        // Image parts ride only when the route supports the image modality
        // (gated at persist time, like the Rust path — keeps replay identical).
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
        // Oversized-result spill (M4): the persisted event carries the
        // pointer text + the artifact card meta; the durable entry keeps the
        // full content (pi-durable owns model context — the M3 split).
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
            // preserved — the Rust artifact_meta merge).
            const meta = artifactMeta(toolMeta, spilled);
            (ev as { meta?: unknown }).meta = meta;
          } catch (error) {
            this.deps.log.error({ err: error, chatId: state.chatId }, "oversized result spill failed, keeping inline");
          }
        }
        await this.append(state, ev);
        return;
      }
      case "pi.compaction": {
        const summary = entry.model?.find((m) => m.role === "user");
        const text = summary && summary.role === "user" && typeof summary.content === "string" ? summary.content : "";
        const ev = compactionEvent(unwrapCompactionSummary(text));
        await this.append(state, ev);
        return;
      }
      default:
        return;
    }
  }

  /** The generation's terminal bookkeeping at run end: an unsent terminal
   *  rides here (failure → Error, stop → zero-usage Done with the last
   *  event id), then the registry entry clears (Rust's turn epilogue). */
  private finishGeneration(state: BridgeState): void {
    if (!this.streamSink || !state.chatId || state.generationId === null) return;
    if (state.failure !== null && !state.doneSent) {
      state.doneSent = true;
      this.emitStream(state, { type: "error", code: "provider", message: state.failure });
    } else if (!state.doneSent) {
      state.doneSent = true;
      this.emitStream(state, {
        type: "done",
        message_id: state.lastEventId ?? uuidv7(),
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
      });
    }
    this.streamSink.close(state.chatId);
  }

  private emitStream(state: BridgeState, event: StreamWireEvent): void {
    if (!this.streamSink || !state.chatId || state.generationId === null) return;
    this.streamSink.event(state.chatId, event);
  }

  private async append(state: BridgeState, ev: ThreadEvent): Promise<ThreadEventRow> {
    return this.deps.threads.appendEvent(state.chatId, ev);
  }
}

/** serde_json-compatible rendering of a parsed tool-call argument value
 *  (BTreeMap key order, sorted) — the Rust blocks carry the arguments as
 *  the raw JSON string, parsed and re-encoded by guild-core. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export type { ThreadEventRow };
