// One conversation's agent events, derived from pi-durable's conversation
// view. pi-durable renders state, not events: `Harness.observeConversation`
// hands every committed change of the view (its entry window and the
// built-in documents) to a synchronous observer. This module diffs each
// change against the one before into the events the chat bridge projects
// (run start/end, the streamed answer, tool cards, appended entries, inbox
// and compaction moves, settled submissions) and delivers them in order to
// one async listener.

import type { Context } from "@earendil-works/chord";
import type {
  ConversationId,
  ConversationView,
  EntryRecord,
  Harness,
  InboxState,
  JsonObject,
  LiveState,
  RunFailure,
  SubmissionId,
  SubmissionRecord,
  ToolSlot,
  WatchCall,
  WatchEnd,
} from "@earendil-works/pi-durable";

type Op = readonly unknown[];

/** One content block of a message as the view carries it. */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "toolCall"; readonly [field: string]: unknown };

/** The in-flight or appended message as the view carries it. */
export type StreamedMessage = {
  readonly role: string;
  readonly content: readonly ContentBlock[];
  readonly model?: string;
  readonly [field: string]: unknown;
};

/** A change to the in-flight message's content. */
export type MessageChange =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: ContentBlock }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; path: readonly unknown[]; delta: string }
  | { type: "block"; contentIndex: number; block: ContentBlock }
  | { type: "message"; message: StreamedMessage };

/** Everything a client needs to resume: the window's entries and the live run. */
export type SnapshotEvent = {
  type: "snapshot";
  entries: readonly EntryRecord[];
  run?: { inputs: SubmissionId[] };
  generation?: { message?: StreamedMessage };
  tools: readonly ToolSlot[];
};

export type ConversationEvent =
  | SnapshotEvent
  | { type: "run_start"; inputs: SubmissionId[] }
  | { type: "run_end"; inputs: SubmissionId[] }
  /** The run ended without an answer because its generation faulted, was
   *  orphaned, or was cut off by restarts. */
  | { type: "task_failed"; taskId: number; kind: "pi.generation"; message: string }
  | { type: "message_start"; message: StreamedMessage }
  | { type: "message_update"; changes: MessageChange[] }
  | { type: "message_end"; entry: EntryRecord }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject; taskId?: number }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "inbox_update" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "submission"; record: SubmissionRecord };

/** Events of one view change before its submission records are read. */
type Pending = ConversationEvent | { type: "settled"; ids: SubmissionId[] };

export interface ConversationEvents {
  /** The view when the stream attached. */
  readonly snapshot: SnapshotEvent;
  /** Delivers every later change's events, in order, one batch at a time. A
   *  batch whose listener throws is not delivered again. */
  start(listener: (events: readonly ConversationEvent[]) => Promise<void>): void;
  stop(): Promise<void>;
  /** Settles when the stream stops or the Session closes or fails. */
  readonly closed: Promise<WatchEnd>;
}

/** Past this many undelivered events the backlog becomes one snapshot. */
const BACKLOG_LIMIT = 10_000;

export interface ConversationEventsOptions {
  /** Undelivered events kept before the backlog becomes one snapshot. */
  backlogLimit?: number;
}

/** Run-failure reasons that are a generation failure (the bridge's error
 *  terminal); the others (model errors, aborts, resets) surface through the
 *  transcript or the stop path. */
const FAILURE_REASONS = new Set<RunFailure["reason"]>(["faulted", "orphaned", "interrupted", "restart_limit"]);

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;
const inboxOf = (view: ConversationView): InboxState | undefined => view.docs["pi.inbox"] as InboxState | undefined;

/** The view as a snapshot event. */
export function snapshotOf(view: ConversationView): SnapshotEvent {
  const live = liveOf(view);
  return {
    type: "snapshot",
    entries: view.entries,
    ...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
    ...(live.generation === undefined
      ? {}
      : {
          generation:
            live.generation.message === undefined ? {} : { message: live.generation.message as StreamedMessage },
        }),
    tools: live.tools ?? [],
  };
}

/** The current view of one conversation as a snapshot. */
export async function conversationSnapshot(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<SnapshotEvent> {
  const observation = await harness.observeConversation(conversationId, { advance: () => {}, end: () => {} }, context);
  observation.detach();
  return snapshotOf(observation.value);
}

/** Attaches to one conversation's events. */
export async function watchConversationEvents(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
  options: ConversationEventsOptions = {},
): Promise<ConversationEvents> {
  const backlogLimit = options.backlogLimit ?? BACKLOG_LIMIT;
  let current: ConversationView | undefined;
  /** Changes that arrived before the attachment resolved. */
  const early: { value: ConversationView; ops: readonly Op[] }[] = [];
  let lastEntryId = -1;
  let queue: Pending[] = [];
  let listener: ((events: readonly ConversationEvent[]) => Promise<void>) | undefined;
  let pumping = false;
  let stopped = false;
  let resolveClosed!: (end: WatchEnd) => void;
  const closed = new Promise<WatchEnd>((resolve) => {
    resolveClosed = resolve;
  });

  const translateInto = (after: ConversationView, ops: readonly Op[]) => {
    const before = current!;
    current = after;
    const added = after.entries.filter((entry) => entry.id > lastEntryId);
    for (const entry of added) lastEntryId = Math.max(lastEntryId, entry.id);
    queue.push(...translate(before, after, ops, added));
    if (queue.length > backlogLimit) queue = [snapshotOf(after)];
    void pump();
  };

  const finish = (end: WatchEnd) => {
    if (stopped) return;
    stopped = true;
    queue = [];
    resolveClosed(end);
  };

  const observation = await harness.observeConversation(
    conversationId,
    {
      advance: (call: WatchCall<ConversationView>) => {
        if (stopped || call.kind !== "value") return;
        if (current === undefined) {
          early.push({ value: call.value, ops: call.ops as readonly Op[] });
          return;
        }
        translateInto(call.value, call.ops as readonly Op[]);
      },
      end: finish,
    },
    context,
  );
  current = observation.value;
  for (const entry of current.entries) lastEntryId = Math.max(lastEntryId, entry.id);
  const snapshot = snapshotOf(current);
  for (const change of early) translateInto(change.value, change.ops);

  async function pump(): Promise<void> {
    if (pumping || listener === undefined) return;
    pumping = true;
    try {
      while (!stopped && queue.length > 0) {
        const batch = queue;
        queue = [];
        const events = await settle(harness, batch, context);
        if (stopped) return;
        try {
          await listener(events);
        } catch {
          // The listener owns its retries; a failed batch is not redelivered.
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    snapshot,
    start(next) {
      listener = next;
      void pump();
    },
    async stop() {
      observation.detach();
      finish({ kind: "stopped" });
      return;
    },
    closed,
  };
}

/** Replaces each `settled` marker with the submission records it names, as
 *  they are now. */
async function settle(harness: Harness, batch: Pending[], context: Context): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = [];
  for (const event of batch) {
    if (event.type !== "settled") {
      events.push(event);
      continue;
    }
    for (const id of event.ids) {
      const submission = await harness.submission(id, context);
      if (submission === undefined) continue;
      events.push({ type: "submission", record: await submission.status(context) });
    }
  }
  return events;
}

/** The tool result for `callId` among `entries`. */
function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
  return entries.find((entry) => {
    const message = entry.model?.[0];
    return message?.role === "toolResult" && message.toolCallId === callId;
  });
}

/** A model-issued call's arguments, from the assistant entry that made it. */
function argumentsOf(entries: readonly EntryRecord[], callId: string): JsonObject {
  for (let index = entries.length - 1; index >= 0; index--) {
    for (const message of entries[index]!.model ?? []) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type === "toolCall" && block.id === callId) {
          return JSON.parse(JSON.stringify(block.arguments)) as JsonObject;
        }
      }
    }
  }
  return {};
}

/** Every event one view change causes: progress, ends and appended entries,
 *  failures and run ends, settled submissions, then what began. */
function translate(
  before: ConversationView,
  after: ConversationView,
  ops: readonly Op[],
  entries: readonly EntryRecord[],
): Pending[] {
  const was = liveOf(before);
  const now = liveOf(after);
  const events: Pending[] = [];

  // Tool starts: a model-issued slot that becomes running.
  const slotsBefore = new Map((was.tools ?? []).map((slot) => [slot.callId, slot]));
  const slots = now.tools ?? [];
  for (const slot of slots) {
    if (slot.status !== "running" || slotsBefore.get(slot.callId)?.status === "running") continue;
    events.push({
      type: "tool_execution_start",
      toolCallId: slot.callId,
      toolName: slot.name,
      args: argumentsOf([...before.entries, ...entries], slot.callId),
      ...(slot.taskId === undefined ? {} : { taskId: Number(slot.taskId) }),
    });
  }

  // The in-flight answer.
  const partialBefore = was.generation?.message;
  const partial = now.generation?.message;
  if (partial !== undefined && partialBefore === undefined) {
    events.push({ type: "message_start", message: partial as StreamedMessage });
  } else if (partial !== undefined && partial !== partialBefore) {
    events.push({ type: "message_update", changes: messageChanges(ops, partial as StreamedMessage) });
  }

  // Tools that end in this change: a slot that becomes done, one created
  // done, or an unfinished one that vanishes because its run ended.
  const toolEnds: { toolCallId: string; toolName: string; entry?: EntryRecord }[] = [];
  const endTool = (slot: ToolSlot, entryId: number | undefined) => {
    const entry = entries.find((candidate) => candidate.id === entryId);
    toolEnds.push({ toolCallId: slot.callId, toolName: slot.name, ...(entry === undefined ? {} : { entry }) });
  };
  for (const previous of slotsBefore.values()) {
    if (previous.status === "done") continue;
    const slot = slots.find((candidate) => candidate.callId === previous.callId);
    if (slot?.status === "done") endTool(slot, slot.entry);
    else if (slot === undefined) endTool(previous, resultOf(entries, previous.callId)?.id);
  }
  for (const slot of slots) {
    if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot, slot.entry);
  }

  // Entries in append order; a tool's end directly precedes its result.
  let assistantAppended = false;
  for (const entry of entries) {
    for (const end of toolEnds) if (end.entry === entry) events.push({ type: "tool_execution_end", ...end });
    const message = entry.model?.[0];
    if (message === undefined) {
      events.push({ type: "entry_appended", entry });
      continue;
    }
    // A streamed answer already started with its first partial.
    const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
    if (message.role === "assistant") assistantAppended = true;
    if (!streamed) events.push({ type: "message_start", message: message as unknown as StreamedMessage });
    events.push({ type: "message_end", entry });
  }
  for (const end of toolEnds) if (end.entry === undefined) events.push({ type: "tool_execution_end", ...end });

  // Compaction ends, the run's failure, then the run's end.
  const compactionsBefore = was.compactions ?? [];
  const compactions = now.compactions ?? [];
  if (compactionsBefore.some(({ taskId }) => !compactions.some((status) => status.taskId === taskId))) {
    events.push({ type: "compaction_end" });
  }
  const failure = now.runFailure;
  if (failure !== undefined && failure.taskId !== was.runFailure?.taskId && FAILURE_REASONS.has(failure.reason)) {
    events.push({
      type: "task_failed",
      taskId: Number(failure.taskId),
      kind: "pi.generation",
      message: failure.detail ?? failure.reason,
    });
  }
  const run = now.run;
  const runBefore = was.run;
  const runChanged = run?.inputs[0] !== runBefore?.inputs[0] || (run === undefined) !== (runBefore === undefined);
  if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs });

  // Submissions this change settled or placed: the ended run's inputs, and
  // items that left the inbox.
  const settled = new Set<SubmissionId>();
  if (runBefore !== undefined && runChanged) for (const id of runBefore.inputs) settled.add(id);
  const inbox = inboxOf(after);
  const inboxBefore = inboxOf(before);
  if (inbox !== inboxBefore) {
    const queued = new Set((inbox?.items ?? []).map((item) => item.id));
    for (const item of inboxBefore?.items ?? []) if (!queued.has(item.id)) settled.add(item.id);
  }
  if (run !== undefined && runChanged) for (const id of run.inputs) settled.add(id);
  if (settled.size > 0) events.push({ type: "settled", ids: [...settled].sort((a, b) => a - b) });
  if (inbox !== inboxBefore) events.push({ type: "inbox_update" });

  // What began.
  if (compactions.some(({ taskId }) => !compactionsBefore.some((status) => status.taskId === taskId))) {
    events.push({ type: "compaction_start" });
  }
  if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
  return events;
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];

/** The view operations on the in-flight message as message changes. */
function messageChanges(ops: readonly Op[], message: StreamedMessage): MessageChange[] {
  const changes: MessageChange[] = [];
  const content = message.content ?? [];
  // A block sent whole already holds every later change to it in this change.
  const whole = new Set<number>();
  for (const op of ops) {
    if (op[0] === "r") return [{ type: "message", message }];
    const path = op[1] as readonly unknown[];
    if (!startsWith(path, PARTIAL_PATH)) {
      // The whole message or generation was replaced.
      if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
      continue;
    }
    const rest = path.slice(PARTIAL_PATH.length);
    if (rest[0] === "usage") continue;
    if (rest[0] !== "content") return [{ type: "message", message }];
    if (rest.length === 1) {
      if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
      for (const [offset, block] of (op[4] as ContentBlock[]).entries()) {
        const type =
          block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
        changes.push({ type, contentIndex: (op[2] as number) + offset, block });
      }
      continue;
    }
    const contentIndex = rest[1] as number;
    const field = rest[2];
    if (whole.has(contentIndex)) continue;
    if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
      changes.push({ type: field === "text" ? "text_delta" : "thinking_delta", contentIndex, delta: op[2] as string });
    } else if (op[0] === "a" && field === "arguments") {
      changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] as string });
    } else {
      whole.add(contentIndex);
      changes.push({ type: "block", contentIndex, block: content[contentIndex]! });
    }
  }
  return changes;
}

function startsWith(path: readonly unknown[], prefix: readonly unknown[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}
