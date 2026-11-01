import { TranscriptProjection } from "./projection.js";
import { canonicalJson } from "../platform/domain/json.js";
// The event bridge: pi-durable `watchEvents()` streams → thread_events rows
// + generating flag + turn-command settlement, with the exact thread-event
// frame contract (turn/step numbering, UsagePayload fields, serde-ordered
// wire rows — see platform/domain/thread-events.ts).
//
// Turn semantics: one Guild turn = one client request = one pi-durable run
// (turn number derived from the log at each run_start, so restarts cannot
// drift); steered inputs join the running turn, follow-ups start the next.
// Steps count model calls within the turn, exactly like the ChatRunner.

import type { Conversation, EntryId, SnapshotEvent, SubmissionRecord, JsonObject } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Logger } from "pino";
import type { StreamWireEvent } from "../hub/protocol.js";
import { uuidv7 } from "../platform/time.js";
import type { ObjectStore } from "../platform/s3.js";
import type { ToolArtifactStore } from "../platform/store/toolArtifacts.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { ThreadStore } from "../platform/store/thread.js";
import type { TurnCommandStore } from "../platform/store/turn_commands.js";
import { turnErrorEvent, type MessageAttachment, type ThreadEventRow } from "../platform/domain/thread-events.js";

export interface LiveBuffers {
  /** Unpersisted streaming buffers of the current generation attempt (the
   *  ThreadState frame's text/thinking fields; empty when idle). */
  text: string;
  thinking: string;
}

/** The live generation fan-out the member-socket feed implements: the
 *  bridge's model deltas and terminals leave the process as live_frame
 *  frames. */
export interface GenerationStreamSink {
  /** Registers the chat's active generation identity — the command id the
   *  turn ack carries as generation_id. Untracked runs keep an already-open
   *  identity. */
  open(chatId: string, generationId: string): void;
  /** One StreamEvent inside the chat's open generation. */
  event(chatId: string, event: StreamWireEvent): void;
  /** The chat's streaming buffers moved — the feed's view republish poll
   *  must capture. */
  dirty(chatId: string): void;
  /** Mirrors unpersisted buffers across a worker boundary without publishing a full view. */
  buffers?(chatId: string, buffers: LiveBuffers): void;
  /** The generation ended. */
  close(chatId: string): void;
}

export interface BridgeDeps {
  threads: ThreadStore;
  chats: ChatStore;
  turnCommands: TurnCommandStore;
  /** The resolved route's image-modality support for the conversation's
   *  current model (gates tool-result image parts at persist time). */
  routeSupportsImages(orgId: string, model: string | null): Promise<boolean>;
  /** Spill machinery: oversized tool results become artifacts. Absent
   *  (tests without an object store) = no spill, inline results only. */
  spill?: { artifacts: ToolArtifactStore; objects: ObjectStore };
  /** Agent-run lifecycle hooks (agent threads only; plain chats no-op). */
  agentRuns?: {
    assistantEvent(chatId: string, row: ThreadEventRow): Promise<void>;
    runEnd(chatId: string, failure: string | null): Promise<void>;
  };
  /** Files the turn attached with `send_file`, as chips for the terminal
   *  assistant message. Absent (tests without an attachment store) = none. */
  agentFiles?: { pending(chatId: string): Promise<MessageAttachment[]> };

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
   *  carries the pointer). */
  spilled: Map<string, string>;
  /** Answer text has streamed for the current assistant message. Some
   *  backends (local vLLM) emit a trailing reasoning delta after the answer
   *  has begun; streaming it live would split the thought block into
   *  [thinking][text][thinking][text]. The tail still accumulates into
   *  buffers.thinking and lands in the durable reasoning block at the turn
   *  boundary, so live frames stop at the first text delta. */
  textStarted: boolean;
  legacyThrough?: number;
}

function invocationOf(submissionId: number): string {
  return `sub:${submissionId}`;
}

export class ChatBridge {
  private readonly states = new Map<string, BridgeState>();
  private streamSink: GenerationStreamSink | null = null;
  private turnEndedHook: ((chatId: string, failed: boolean) => Promise<void>) | null = null;

  private readonly projection: TranscriptProjection;

  constructor(private readonly deps: BridgeDeps) {
    this.projection = new TranscriptProjection(deps);
  }

  /** Wires the push lane's turn-end hook (unset = no notifications). */
  setTurnEnded(hook: ((chatId: string, failed: boolean) => Promise<void>) | null): void {
    this.turnEndedHook = hook;
  }

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
        textStarted: false,
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

  async recover(
    conversation: Conversation,
    submissions: readonly SubmissionRecord[] = [],
    through?: EntryId,
  ): Promise<void> {
    await this.projection.recover(conversation, this.state(String(conversation.id)), submissions, through);
  }

  async persistTaskFailure(conversationId: string, taskId: number, message: string): Promise<ThreadEventRow> {
    return this.deps.threads.appendTaskFailure(this.state(conversationId).chatId, taskId, turnErrorEvent(message));
  }

  private async restoreSnapshot(conversationId: string, state: BridgeState, snapshot: SnapshotEvent): Promise<void> {
    await this.syncQueuedModes(state, snapshot.inbox);
    state.buffers = { text: "", thinking: "" };
    state.textStarted = false;
    if (snapshot.run) {
      await this.handleOne(conversationId, state, { type: "run_start", inputs: snapshot.run.inputs });
      const cursor = await this.deps.threads.projectionCursor(state.chatId, Number(conversationId));
      state.turn = cursor.turn;
      state.step = cursor.step;
    } else {
      await this.deps.chats.setGenerating(state.orgId, state.chatId, false);
      this.finishGeneration(state);
    }
    if (snapshot.generation?.message) {
      await this.handleOne(conversationId, state, { type: "message_start", message: snapshot.generation.message });
    }
    for (const tool of snapshot.tools) {
      if (tool.status === "done") continue;
      const call = snapshot.entries
        .flatMap((entry) => entry.model ?? [])
        .flatMap((message) =>
          message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
        )
        .find((block) => block.type === "toolCall" && block.id === tool.callId);
      await this.handleOne(conversationId, state, {
        type: "tool_execution_start",
        toolCallId: tool.callId,
        toolName: tool.name,
        args: call?.type === "toolCall" ? (JSON.parse(JSON.stringify(call.arguments)) as JsonObject) : {},
        taskId: tool.taskId!,
      });
    }
    this.streamSink?.dirty(state.chatId);
  }

  private async syncQueuedModes(state: BridgeState, items: readonly { id: number; mode: string }[]): Promise<void> {
    for (const item of items) {
      if (item.mode === "write") continue;
      for (const command of await this.deps.turnCommands.byInvocation(invocationOf(Number(item.id)))) {
        await this.deps.threads.setQueuedMode(state.chatId, command.id, item.mode === "steer" ? "steer" : "queue");
      }
    }
  }

  private async projectEntry(state: BridgeState, entry: EntryRecord): Promise<void> {
    await this.projection.project(state, entry);
    const message = entry.kind === "pi.assistant" ? entry.model?.find((item) => item.role === "assistant") : undefined;
    if (
      message?.role === "assistant" &&
      message.stopReason !== "aborted" &&
      !message.content.some((block) => block.type === "toolCall") &&
      state.lastEventId &&
      state.generationId &&
      this.streamSink
    ) {
      state.doneSent = true;
      this.emitStream(state, {
        type: "done",
        message_id: state.lastEventId,
        cost_usd: message.usage.cost.total,
        tokens_in: message.usage.input,
        tokens_out: message.usage.output,
      });
    }
  }

  /** A failed delivery is retried by the host without stopping the agent. */
  handle = async (conversationId: string, events: readonly AgentEvent[]): Promise<void> => {
    const state = this.state(conversationId);
    if (!state.chatId) return;
    for (const event of events) {
      try {
        await this.handleOne(conversationId, state, event);
        this.streamSink?.buffers?.(state.chatId, state.buffers);
      } catch (error) {
        this.deps.log.error({ err: error, chatId: state.chatId, event: event.type }, "bridge event failed");
        throw error;
      }
    }
  };

  private async handleOne(_conversationId: string, state: BridgeState, event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "snapshot":
        await this.restoreSnapshot(_conversationId, state, event);
        return;
      case "run_start": {
        state.handledEntries.clear();
        state.spilled.clear();
        state.turn = (await this.deps.threads.latestTurn(state.chatId)) + 1;
        state.step = 0;
        state.doneSent = false;
        state.failure = null;
        state.lastEventId = null;
        await this.deps.chats.setGenerating(state.orgId, state.chatId, true);
        let generationId: string | null = null;
        let oldestPosition: number | null = null;
        for (const input of event.inputs) {
          const commands = await this.deps.turnCommands.forSubmission(state.chatId, Number(input));
          for (const command of commands) {
            const claimed = await this.deps.turnCommands.begin(command.id, state.chatId, invocationOf(Number(input)));
            void claimed;
            if (
              generationId === null ||
              (command.position !== null && command.position < (oldestPosition ?? Number.MAX_SAFE_INTEGER))
            ) {
              generationId = command.id;
              oldestPosition = command.position;
            }
          }
        }
        // Untracked runs keep an already-open generation identity; a cold
        // untracked run streams under a fresh id no client matches.
        state.generationId = generationId ?? state.generationId ?? uuidv7();
        if (this.streamSink && state.chatId) this.streamSink.open(state.chatId, state.generationId);
        return;
      }
      case "run_end": {
        await this.deps.chats.setGenerating(state.orgId, state.chatId, false);
        // The turn is over: if its owner has no live socket, this is the one
        // moment a notification is worth sending.
        if (this.turnEndedHook !== null) {
          await this.turnEndedHook(state.chatId, state.failure !== null).catch((error: unknown) =>
            this.deps.log.warn({ err: error, chatId: state.chatId }, "turn-end hook failed"));
        }
        for (const input of event.inputs) {
          const commands = await this.deps.turnCommands.byInvocation(invocationOf(Number(input)));
          for (const command of commands) {
            await this.deps.turnCommands.finish(command.id, invocationOf(Number(input)), false);
          }
        }
        await this.deps.agentRuns?.runEnd(state.chatId, state.failure);
        this.finishGeneration(state);
        return;
      }
      case "task_failed": {
        // The run's own failure (an Error frame at the failure point).
        // Tool/compaction task failures are the executor paths' own surface.
        if (event.kind !== "pi.generation") return;
        await this.persistTaskFailure(_conversationId, Number(event.taskId), event.message);
        if (state.generationId === null || state.doneSent) return;
        state.doneSent = true;
        state.failure = event.message;
        // Persisted so the failure survives reload and socket loss — the
        // live error frame alone dies with the connection (deploy restarts).
        this.emitStream(state, { type: "error", code: "provider", message: event.message });
        return;
      }
      case "message_start": {
        state.buffers.text = "";
        state.buffers.thinking = "";
        state.textStarted = false;
        if (event.message.role === "assistant") {
          state.currentModel = (event.message as { model?: string }).model ?? state.currentModel;
          // The first partial commit arrives as message_start with the
          // content streamed so far — seed the buffers and stream it.
          for (const block of (event.message as { content: { type: string; text?: string; thinking?: string }[] })
            .content) {
            if (block.type === "text" && block.text) {
              state.buffers.text += block.text;
              state.textStarted = true;
              this.emitStream(state, { type: "delta", content: block.text });
            } else if (block.type === "thinking" && block.thinking) {
              state.buffers.thinking += block.thinking;
              if (!state.textStarted) this.emitStream(state, { type: "thinking_delta", content: block.thinking });
            }
          }
          // No dirty() here: live frames carry the stream; the view poll
          // publishes only at turn boundaries (the run-end generating flip
          // is the turn's single view broadcast).
        }
        return;
      }
      case "message_update": {
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            state.buffers.text += change.delta;
            state.textStarted = true;
            this.emitStream(state, { type: "delta", content: change.delta });
          } else if (change.type === "thinking_delta") {
            state.buffers.thinking += change.delta;
            if (!state.textStarted) this.emitStream(state, { type: "thinking_delta", content: change.delta });
          } else if (change.type === "text_start") {
            // A block inserted whole holds its text so far (the first chunk
            // of the block rides the insert).
            const block = change.block as { text?: string };
            state.buffers.text += block.text ?? "";
            state.textStarted = true;
            if (block.text) this.emitStream(state, { type: "delta", content: block.text });
          } else if (change.type === "thinking_start") {
            const block = change.block as { thinking?: string };
            state.buffers.thinking += block.thinking ?? "";
            if (block.thinking && !state.textStarted)
              this.emitStream(state, { type: "thinking_delta", content: block.thinking });
          } else if (change.type === "block" && change.block.type === "text") {
            state.buffers.text += change.block.text;
            state.textStarted = true;
            this.emitStream(state, { type: "delta", content: change.block.text });
          } else if (change.type === "block" && change.block.type === "thinking") {
            state.buffers.thinking += change.block.thinking;
            if (!state.textStarted) this.emitStream(state, { type: "thinking_delta", content: change.block.thinking });
          } else if (change.type === "message") {
            // The whole partial was replaced: resync the buffers (the stream
            // frames already delivered the prefix; the view poll corrects).
            state.buffers.text = "";
            state.buffers.thinking = "";
            state.textStarted = false;
            for (const block of (change.message as { content: { type: string; text?: string; thinking?: string }[] })
              .content) {
              if (block.type === "text") state.buffers.text += block.text ?? "";
              else if (block.type === "thinking") state.buffers.thinking += block.thinking ?? "";
            }
            if (state.buffers.text !== "") state.textStarted = true;
          }
        }
        // No dirty() on deltas — same turn-boundary contract as above.
        return;
      }
      case "message_end": {
        state.buffers.text = "";
        state.buffers.thinking = "";
        // The finalized entry rides the event (assistant messages; tool
        // results arrive via tool_execution_end). entry_appended events do
        // not repeat run-generated entries.
        if (event.entry && !state.handledEntries.has(String(event.entry.id))) {
          await this.projectEntry(state, event.entry);
          state.handledEntries.add(String(event.entry.id));
        }
        return;
      }
      case "tool_execution_start": {
        // Nested calls (a codemode script's tools.*) are not transcript
        // cards: only the model-issued call that owns them is.
        if (event.parentToolCallId !== undefined) return;
        // The tool-call card (ToolStarted into the generation stream; the
        // durable harness's tools execute server-side).
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
        if (event.parentToolCallId !== undefined) return;
        if (event.entry && !state.handledEntries.has(String(event.entry.id))) {
          const result = event.entry.model?.find((m) => m.role === "toolResult");
          await this.projectEntry(state, event.entry);
          state.handledEntries.add(String(event.entry.id));
          // The result card rides after the persisted row (ToolCompleted
          // carries the finished tool's content — the spilled pointer when
          // the result spilled).
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
        await this.projectEntry(state, event.entry);
        state.handledEntries.add(String(event.entry.id));
        return;
      }
      case "inbox_update":
        await this.syncQueuedModes(state, event.items);
        return;
      case "compaction_start":
      case "compaction_end":
        // The view's `compacting` flag moved: the feed re-captures and
        // republishes it. A compaction that ends without a summary or fails
        // appends no row, so this is the only push that lowers the flag.
        this.streamSink?.dirty(state.chatId);
        return;
      case "submission": {
        // A write leaving the inbox can be a compaction's queued summary:
        // the view's `compacting` flag may have moved.
        if (event.record.type === "write" && event.record.status !== "queued") this.streamSink?.dirty(state.chatId);
        // Placement (queued → placed): the durable inbox actually handed
        // the input to a run — the Codex-style queued chip becomes a real
        // transcript message. The accept-time echo was flagged `queued`
        // (not yet seen by the model); move it to a fresh seq with the
        // flag cleared so the desktop renders it at the placement position.
        // A fast run closes the placed→done window inside one watch batch,
        // so the delivered record may only ever carry the terminal status:
        // deliver on both (a no-op when the echo is absent or already
        // delivered).
        if (
          (event.record.status === "placed" || event.record.status === "done") &&
          typeof event.record.requestId === "string"
        ) {
          await this.deps.threads.deliverQueuedEvent(state.chatId, event.record.requestId);
          if (event.record.status === "done") {
            for (const command of await this.deps.turnCommands.byInvocation(invocationOf(Number(event.record.id)))) {
              await this.deps.turnCommands.finish(command.id, invocationOf(Number(event.record.id)), false);
            }
          }
          return;
        }
        // Settled-but-unanswered inputs (stop / archive withdrawal): mark
        // cancelled so no waiting head wedges the chat, and drop the
        // never-delivered queued echo — a withdrawn input leaves no
        // transcript trace, exactly like a chip the user trashed.
        if (event.record.status === "unanswered") {
          if (event.record.entry !== undefined && event.record.requestId) {
            await this.deps.threads.deliverQueuedEvent(state.chatId, event.record.requestId);
          }
          const commands = await this.deps.turnCommands.byInvocation(invocationOf(Number(event.record.id)));
          for (const command of commands) {
            await this.deps.turnCommands.settleCancelled(command.id, invocationOf(Number(event.record.id)));
            if (event.record.entry === undefined) await this.deps.threads.deleteQueuedEvent(state.chatId, command.id);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** The generation's terminal bookkeeping at run end: an unsent terminal
   *  rides here (failure → Error, stop → zero-usage Done with the last
   *  event id), then the registry entry clears. */
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
    state.generationId = null;
    state.handledEntries.clear();
    state.spilled.clear();
  }

  private emitStream(state: BridgeState, event: StreamWireEvent): void {
    if (!this.streamSink || !state.chatId || state.generationId === null) return;
    this.streamSink.event(state.chatId, event);
  }
}

export type { ThreadEventRow };
