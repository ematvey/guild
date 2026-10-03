// The event bridge: pi-durable `watchEvents()` streams → thread_events rows
// + generating flag + turn-command settlement, with the EXACT frame contract
// the Rust ChatRunner wrote (turn/step numbering, UsagePayload fields,
// serde-ordered wire rows — see chats/thread-events.ts).
//
// Turn semantics: one Guild turn = one client request = one pi-durable run
// (turn number derived from the log at each run_start, so restarts cannot
// drift); steered inputs join the running turn, follow-ups start the next.
// Steps count model calls within the turn, exactly like the ChatRunner.

import type { AgentEvent } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Logger } from "pino";
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
} from "./thread-events.js";

export interface LiveBuffers {
  /** Unpersisted streaming buffers of the current generation attempt (the
   *  ThreadState frame's text/thinking fields; empty when idle). */
  text: string;
  thinking: string;
}

export interface BridgeDeps {
  threads: ThreadStore;
  chats: ChatStore;
  turnCommands: TurnCommandStore;
  /** The resolved route's image-modality support for the conversation's
   *  current model (gates tool-result image parts at persist time, like the
   *  Rust persist path). */
  routeSupportsImages(orgId: string, model: string | null): Promise<boolean>;
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
}

function invocationOf(submissionId: number): string {
  return `sub:${submissionId}`;
}

export class ChatBridge {
  private readonly states = new Map<string, BridgeState>();

  constructor(private readonly deps: BridgeDeps) {}

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
        await this.deps.chats.setGenerating(state.orgId, state.chatId, true);
        for (const input of event.inputs) {
          const commands = await this.deps.turnCommands.byInvocation(invocationOf(Number(input)));
          for (const command of commands) {
            const claimed = await this.deps.turnCommands.begin(command.id, state.chatId, invocationOf(Number(input)));
            void claimed;
          }
        }
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
        return;
      }
      case "message_start": {
        state.buffers.text = "";
        state.buffers.thinking = "";
        if (event.message.role === "assistant") state.currentModel = event.message.model;
        return;
      }
      case "message_update": {
        for (const change of event.changes) {
          if (change.type === "text_delta") state.buffers.text += change.delta;
          else if (change.type === "thinking_delta") state.buffers.thinking += change.delta;
          else if (change.type === "block" && change.block.type === "text") state.buffers.text += change.block.text;
          else if (change.type === "block" && change.block.type === "thinking") state.buffers.thinking += change.block.thinking;
        }
        return;
      }
      case "message_end": {
        state.buffers.text = "";
        state.buffers.thinking = "";
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
        const ev = assistantMessageEvent(
          state.turn,
          state.step,
          blocks,
          {
            tokens_in: message.usage.input,
            tokens_out: message.usage.output,
            cost_usd: message.usage.cost.total,
          },
          message.model,
          message.stopReason === "aborted" ? true : undefined,
        );
        await this.append(state, ev);
        return;
      }
      case "pi.tool-result": {
        const result = entry.model?.find((m) => m.role === "toolResult");
        if (!result || result.role !== "toolResult") return;
        const content = result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
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
        );
        if (eventImages.length > 0) (ev as { images: string[] }).images = eventImages;
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

  private async append(state: BridgeState, ev: ThreadEvent): Promise<void> {
    await this.deps.threads.appendEvent(state.chatId, ev);
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
