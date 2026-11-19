//! Thread reducer: the single source of the merge rules turning the durable
//! event log, the live model buffers and the optimistic send path into the
//! visible blocks a chat view renders. Per-chat state ({blocks, watermark,
//! pending send, compaction keys}) advances incrementally — a sequenced
//! ThreadState publish applies only its new events and re-stamps the buffer
//! blocks, never re-deriving the whole thread per streaming frame.
//!
//! Boundary: visible blocks only. Sockets, transport and composer state
//! stay in the component; this is a plain module, not a store.

import type { MessageAttachmentMeta, QueuedInput, StreamEvent, ThreadEventRow, ThreadState } from "./thread-events";

// ---------- block shapes ----------

/** A subagent spawn as its own transcript record: the request the parent
 *  sent and the thread it created. */
export interface ChildSpawnBlock {
  threadId: string;
  /** The durable chat id the child thread projects into. Null when the event
   *  carried none; the block then has no thread to open. */
  chatId?: string | null;
  agentName: string;
  /** The session name its spawner chose. */
  title?: string | null;
  /** The request the parent sent (empty for events older than the field). */
  task?: string;
  startedAt: string;
}

/** A subagent's terminal record in the parent transcript. */
export interface ChildResultBlock {
  threadId: string;
  chatId?: string | null;
  agentName: string;
  title?: string | null;
  status: string;
  reason?: string;
  finalText?: string;
  startedAt?: string;
  finishedAt: string;
}

/** A close of a subagent thread, kept in the parent transcript as the record
 *  that the thread was closed. */
export interface ChildClosedBlock {
  threadId: string;
  chatId?: string | null;
  agentName: string;
  title?: string | null;
}

export interface ToolBlock {
  callId: string;
  name: string;
  args: string;
  executor: "client" | "server";
  status: "running" | "done" | "error";
  content?: string;
  meta?: ToolMeta;
  /// Coarse category from the server (web_search | web_browse | generic):
  /// drives the native label/icon regardless of the providing integration.
  kind?: string;
  /// Wall-clock stamps (ISO) for the working card's elapsed time: when the
  /// call was issued (the anchor event row / the stream frame) and when its
  /// result landed (the tool_result row / frame). Absent on a call that
  /// never finished.
  ts?: string;
  endTs?: string;
}

/// One durable approval gate (design spec section F): a client tool waiting
/// for (or having received) the user's allow/deny decision. `expired` marks
/// an orphaned call: its turn ended before the card was answered, so the
/// call can never execute — the card stays visible, non-actionable.
export interface ApprovalBlock {
  callId: string;
  name: string;
  args: string;
  status: "pending" | "approved" | "denied" | "expired";
  reason?: string;
  /// The approval judge's verdict, when it ran and did not approve. Its
  /// reason is why the card exists at all.
  judge?: { reason?: string; ms?: number };
}

/// One durable compaction event (compaction spec section E): the model's
/// summary of everything before this point in the thread.
export interface CompactionBlock {
  summary: string;
  model?: string | null;
  keepLast?: number | null;
}

/// Widget payload persisted on tool/result events (spec C.2). Loose: the
/// server owns the shape, unknown fields are ignored by the widgets.
export interface ToolMeta {
  card?: string | ArtifactCard;
  kind?: string;
  sources?: { url: string; title?: string; snippet?: string }[];
  truncated?: boolean;
  url?: string;
  status_code?: number;
  title?: string;
  output?: string;
  exit_code?: number;
  path?: string;
  offset?: number;
  total_lines?: number;
  lang?: string;
  /// Codemode script call (server: pi-durable result details): the
  /// script's nested tool calls in call order, terminal statuses only.
  calls?: CodemodeCallRow[];
}

/// One nested tool call a codemode script made, as pi-durable records it
/// in the codemode result's details (args cut server-side for display).
export interface CodemodeCallRow {
  id: number;
  name: string;
  args?: string;
  status: "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
}

/// Download card on a spilled tool_result (the server puts it in
/// meta.card): filename, size and the artifact id to fetch bytes from.
/// `path` is the model-facing materialized path — shown for context, not
/// clickable.
export interface ArtifactCard {
  card: "artifact";
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  path: string;
}

/** Narrows meta to a well-formed artifact card; every other card shape
 * (string card kinds, malformed objects) renders as its old widget. The
 * server writes the card keys FLAT on meta (`card` is the string
 * "artifact" alongside id/filename/…); a nested card object is also
 * accepted for compatibility. */
export function artifactCardOf(t: { meta?: unknown | null }): ArtifactCard | null {
  const meta = t.meta as (Partial<ArtifactCard> & { card?: unknown; kind?: unknown }) | null | undefined;
  if (!meta || typeof meta !== "object") return null;
  const nested = (meta.card ?? null) as (Partial<ArtifactCard> & { card?: unknown; kind?: unknown }) | null;
  const a =
    meta.card === "artifact" || meta.kind === "artifact"
      ? meta
      : nested && typeof nested === "object" && (nested.card === "artifact" || nested.kind === "artifact")
        ? nested
        : null;
  if (!a) return null;
  if (typeof a.id !== "string" || !a.id) return null;
  if (typeof a.filename !== "string" || !a.filename) return null;
  if (typeof a.size_bytes !== "number" || !(a.size_bytes >= 0)) return null;
  return {
    card: "artifact",
    id: a.id,
    filename: a.filename,
    content_type: typeof a.content_type === "string" && a.content_type ? a.content_type : "application/octet-stream",
    size_bytes: a.size_bytes,
    path: typeof a.path === "string" ? a.path : "",
  };
}

export interface RenderBlock {
  kind:
    | "user"
    | "text"
    | "error"
    | "reasoning"
    | "tool"
    | "approval"
    | "compaction"
    | "child_spawn"
    | "child_result"
    | "child_closed";
  text: string;
  /// Stable React key. Derived blocks use the source event's seq (plus an
  /// in-event index); streaming-built blocks use a live counter.
  key: string;
  /// kind === "user": the backing thread-event id (the turn command id —
  /// delivery/withdrawal reconcile matches blocks by it, not by key: a
  /// delivered queued send MOVES to a fresh seq).
  eventId?: string;
  /// A message's attached files (user uploads on kind === "user", the
  /// turn's `send_file` files on the message's last kind === "text" block).
  /// Metadata only; images may carry a local preview URL for optimistic
  /// rendering.
  attachments?: (MessageAttachmentMeta & { previewUrl?: string })[];
  /// An optimistic user command not yet present in the durable history.
  pending?: boolean;
  /// Admitted while a turn was generating: not yet seen by the model —
  /// rendered as a queued chip above the composer, not a transcript bubble,
  /// until the inbox places it (the server clears the flag at placement).
  queued?: boolean;
  /// Requested placement for the same chip: "steer" | "queue".
  queuedMode?: "steer" | "queue";
  /// What a queued chip waits to deliver: a member's message (the only kind
  /// the member can steer or withdraw), a posted turn, or a child's result.
  queuedKind?: QueuedInput["kind"];
  /// kind === "reasoning": the accumulated thinking text.
  reasoningText?: string;
  /// kind === "text": the turn was stopped mid-stream; the text is the
  /// delivered prefix.
  interrupted?: boolean;
  /// Event timestamp (ISO): when this block's source event row landed —
  /// the working card's timeline anchor. Stream-built blocks stamp the
  /// frame's arrival instead (kept across the re-stamp, never reset).
  ts?: string;
  /// kind === "text": the message was posted into the thread outside a run
  /// (a Routine's `send_message`, an agent's message to another thread). It
  /// is a message of its own, not a step of a turn, so a settled turn never
  /// folds it.
  posted?: boolean;
  tool?: ToolBlock;
  approval?: ApprovalBlock;
  compaction?: CompactionBlock;
  /// kind === "child_spawn": the request and the thread it created.
  childSpawn?: ChildSpawnBlock;
  /// kind === "child_result": the child's terminal record.
  childResult?: ChildResultBlock;
  /// kind === "child_closed": the close record.
  childClosed?: ChildClosedBlock;
}

export interface PendingSend {
  chatId: string | null;
  text: string;
  key: string;
  sentAt: number;
  attachments?: (MessageAttachmentMeta & { previewUrl?: string })[];
  /// Sent while the chat was generating: the optimistic block renders as a
  /// queued chip from the start (the durable echo keeps the flag).
  queued?: boolean;
  queuedMode?: "steer" | "queue";
}

/** The queued-chip fields a user_message event carries (absent = delivered). */
function queuedFieldsOf(ev: { queued?: boolean; mode?: string }): {
  queued?: boolean;
  queuedMode?: "steer" | "queue";
} {
  if (!ev.queued) return {};
  return { queued: true, queuedMode: ev.mode === "steer" ? "steer" : "queue" };
}

/** Stamps a message's attached files onto its last text block (or a text
 *  block of its own when it said nothing), so the chips render with the
 *  text they belong to. */
function stampFiles(
  blocks: RenderBlock[],
  start: number,
  attachments: readonly MessageAttachmentMeta[] | undefined,
  ts: string,
  key: () => string,
): void {
  if (attachments === undefined || attachments.length === 0) return;
  for (let j = blocks.length - 1; j >= start; j--) {
    if (blocks[j]!.kind === "text") {
      blocks[j] = { ...blocks[j]!, attachments: [...attachments] };
      return;
    }
  }
  append(blocks, { kind: "text", text: "", attachments: [...attachments], ts, key: key() });
}

function clearedQueuedFields(): { queued: undefined; queuedMode: undefined } {
  return { queued: undefined, queuedMode: undefined };
}

/** Delivery/withdrawal reconcile for one view's queued sends against the
 *  authoritative log: a queued block whose echo row lost the flag (moved to
 *  the placement position) is delivered — the fan-out lane already
 *  repositioned it, this just re-stamps; a queued block whose row VANISHED
 *  was withdrawn (trash / stop / archive) — it leaves the transcript. The
 *  authoritative ThreadState carries the full log, so this runs on every
 *  state application; the fan-out lane cannot see deletions. */
function reconcileQueuedSends(
  blocks: RenderBlock[],
  rows: ThreadEventRow[],
  /// Seq of the authoritative window's oldest row: a block older than this
  /// came from a loaded earlier page, and a queued row can never be that
  /// old, so it is neither withdrawn nor re-stamped.
  windowOldest = Number.NEGATIVE_INFINITY,
): RenderBlock[] {
  const byId = new Map<string, ThreadEventRow>();
  for (const r of rows) {
    const prev = byId.get(r.id);
    if (!prev || r.seq > prev.seq) byId.set(r.id, r);
  }
  return blocks.flatMap((b) => {
    if (b.kind !== "user" || b.eventId === undefined) return [b];
    const seq = /^(\d+):/.exec(b.key);
    if (seq !== null && Number(seq[1]) < windowOldest) return [b];
    const row = byId.get(b.eventId);
    if (!row) return b.pending ? [b] : []; // withdrawn; an in-flight optimistic send keeps waiting for its echo
    if (row.event.type !== "user_message") return [b];
    // Identity-preserving: untouched blocks keep their object so the
    // applyEvent dedupe and React memoization keep working.
    const queued = queuedFieldsOf(row.event);
    if (!!b.queued === (row.event.queued === true) && (!b.queued || b.queuedMode === queued.queuedMode)) return [b];
    return [{ ...b, ...clearedQueuedFields(), ...queued }];
  });
}

/** Rebuilds a view's queued chips from the server's queue (ThreadState
 *  `queue`, the conversation's inbox). A queued input has no thread row: its
 *  row arrives once the inbox places it, and the user_message fold then
 *  replaces the chip. An optimistic send keeps its own block until the
 *  queue lists it or its row arrives. */
function syncQueue(blocks: RenderBlock[], queue: readonly QueuedInput[]): RenderBlock[] {
  const placed = new Set(
    blocks.flatMap((b) => (b.kind === "user" && !b.queued && !b.pending && b.eventId ? [b.eventId] : [])),
  );
  const listed = new Set(queue.map((item) => item.id));
  const kept = blocks.filter((b) => !(b.kind === "user" && b.queued && (!b.pending || listed.has(b.eventId ?? ""))));
  const chips: RenderBlock[] = queue
    .filter((item) => !placed.has(item.id))
    .map((item) => ({
      kind: "user",
      text: item.text,
      key: `queued-${item.id}`,
      ...(item.kind === "message" ? { eventId: item.id } : {}),
      attachments: item.attachments,
      queued: true,
      queuedMode: item.mode,
      queuedKind: item.kind,
    }));
  return [...kept, ...chips];
}

// ---------- derivation (event log → blocks) ----------

let liveKeyCounter = 0;
/// Key for blocks the stream builds (no source event seq to derive from).
function liveKey(): string {
  return `live-${++liveKeyCounter}`;
}

/// Arrival stamp for stream-built blocks: the durable rows carry their own
/// created_at; the live lane only has the wall clock.
const nowIso = () => new Date().toISOString();

/// Tools the desktop executor runs locally (mirrors protocol `client_tool_specs`).
const CLIENT_TOOL_NAMES = ["read_file", "execute", "edit_file", "write_file"];

/** A result or close event may carry no label of its own; the spawn record
 *  already in the transcript names the thread and holds its chat id. */
function spawnLabel(
  blocks: readonly RenderBlock[],
  threadId: string,
): { chatId: string | null; agentName: string; title: string | null } {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const spawn = blocks[i]?.childSpawn;
    if (spawn !== undefined && spawn.threadId === threadId) {
      return { chatId: spawn.chatId ?? null, agentName: spawn.agentName, title: spawn.title ?? null };
    }
  }
  return { chatId: null, agentName: "Subagent", title: null };
}

/** The state one event folds into: the visible blocks and the call-id maps
 *  that join later events (tool results, approval decisions) to theirs. */
export interface ThreadFold {
  blocks: RenderBlock[];
  toolsByCall: Map<string, ToolBlock>;
  approvalsByCall: Map<string, ApprovalBlock>;
}

/** The user's typed text: event content is the model-facing turn, which
 *  also carries inlined "[Attachment: …]" blocks and the skill-invocation
 *  block the client expanded for `/name` mentions. */
function typedText(content: string): string {
  const at = content.indexOf("\n\n[Attachment: ");
  const inv = content.indexOf("\n\n---\nInvoked skills");
  const cut = [at, inv].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  return cut >= 0 ? content.slice(0, cut) : content;
}

/** Appends a block. Only the thread's last block may be an error (see
 *  `pruneStaleErrors`): a trailing error is superseded by what follows. */
function append(blocks: RenderBlock[], block: RenderBlock): void {
  if (blocks[blocks.length - 1]?.kind === "error") blocks.pop();
  blocks.push(block);
}

/** Replaces the block holding `prev` with one holding `next`, searching from
 *  the end (a join usually lands near its call). */
function replaceTool(blocks: RenderBlock[], prev: ToolBlock, next: ToolBlock): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "tool" && b.tool === prev) {
      blocks[i] = { ...b, tool: next };
      return;
    }
  }
}

function replaceApproval(acc: ThreadFold, prev: ApprovalBlock, next: ApprovalBlock): void {
  acc.approvalsByCall.set(next.callId, next);
  const i = acc.blocks.findIndex((x) => x.kind === "approval" && x.approval === prev);
  if (i >= 0) acc.blocks[i] = { ...acc.blocks[i]!, approval: next };
}

/** Folds one durable event row into `acc`, in place: the one rule set both
 *  the full derivation and the incremental reducer use. Every block an
 *  event creates is keyed `<seq>:<n>`, `n` counting that event's blocks, so
 *  a key is unique within the thread and the same whichever path built it.
 *  Blocks and tool/approval records are replaced, never mutated, so
 *  memoized rows re-render. Keeps "only the last block may be an error"
 *  when `acc` already satisfies it. */
export function foldEvent(acc: ThreadFold, row: ThreadEventRow): void {
  const ev = row.event;
  const blocks = acc.blocks;
  let n = 0;
  const nextKey = () => `${row.seq}:${n++}`;
  switch (ev.type) {
    case "user_message": {
      // Delivery of a queued send MOVES the echo to a fresh seq: a block for
      // this event id already renders (the queued chip) — reposition it at
      // the placement point (the end, in seq order) with the placement flags
      // reconciled, instead of appending a twin. A mode update can move its
      // seq while the input is still queued.
      const i = blocks.findIndex((b) => b.kind === "user" && b.eventId === row.id);
      if (i >= 0) blocks.splice(i, 1);
      append(blocks, {
        kind: "user",
        text: typedText(ev.content),
        attachments: ev.attachments,
        eventId: row.id,
        ...queuedFieldsOf(ev),
        ts: row.created_at,
        key: nextKey(),
      });
      break;
    }
    case "system_message":
      break; // server-owned prompt, log-only
    case "assistant_message": {
      // This step's streamed buffers are now durable: the live reasoning
      // block the deltas built and the trailing streamed text are superseded
      // by this event's blocks — drop them or the step renders twice. The
      // live block's open-time carries onto its durable successor, or the
      // working card's elapsed clock resets at every commit.
      let liveThinkTs: string | undefined;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.kind === "reasoning" && b.key.startsWith("live-")) {
          liveThinkTs ??= b.ts;
          blocks.splice(i, 1);
        } else if (b.kind === "text" && b.key.startsWith("unpersisted-")) {
          blocks.splice(i, 1);
        }
      }
      const start = blocks.length;
      let reasoningSeen = false;
      for (const b of ev.blocks) {
        if (b.type === "reasoning") {
          append(blocks, {
            kind: "reasoning",
            text: "",
            reasoningText: b.text,
            ts: !reasoningSeen && liveThinkTs ? liveThinkTs : row.created_at,
            key: nextKey(),
          });
          reasoningSeen = true;
        } else if (b.type === "text") {
          append(blocks, { kind: "text", text: b.text, ts: row.created_at, posted: ev.posted, key: nextKey() });
        } else {
          const executor = CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server";
          // A live tool_started frame may have provisioned this row before
          // the carrying message fanned out: adopt it instead of pushing a
          // duplicate block (its arrival stamp is the call's true start).
          const existing = acc.toolsByCall.get(b.id);
          if (existing) {
            const next: ToolBlock = {
              ...existing,
              name: b.name,
              args: b.arguments,
              executor,
              ts: existing.ts ?? row.created_at,
            };
            acc.toolsByCall.set(b.id, next);
            replaceTool(blocks, existing, next);
          } else {
            const tb: ToolBlock = {
              callId: b.id,
              name: b.name,
              args: b.arguments,
              executor,
              status: "done", // filled by the matching tool_result
              ts: row.created_at,
            };
            acc.toolsByCall.set(b.id, tb);
            append(blocks, { kind: "tool", text: "", tool: tb, key: nextKey() });
          }
        }
      }
      if (ev.interrupted) {
        for (let j = blocks.length - 1; j >= start; j--) {
          if (blocks[j]!.kind === "text") {
            blocks[j] = { ...blocks[j]!, interrupted: true };
            break;
          }
        }
      }
      // Files before the error: the error stays the step's last block.
      stampFiles(blocks, start, ev.attachments, row.created_at, nextKey);
      if (ev.error) append(blocks, { kind: "error", text: ev.error, key: nextKey() });
      break;
    }
    case "tool_result": {
      const meta = (ev.meta ?? undefined) as ToolMeta | undefined;
      const kind = (ev as { kind?: string | null }).kind ?? undefined;
      const tb = acc.toolsByCall.get(ev.call_id);
      if (tb) {
        const next: ToolBlock = {
          ...tb,
          content: ev.content,
          status: ev.is_error ? "error" : "done",
          meta,
          kind,
          endTs: row.created_at,
        };
        acc.toolsByCall.set(tb.callId, next);
        replaceTool(blocks, tb, next);
      } else {
        // Orphan result (call block missing): render it anyway rather than drop it.
        append(blocks, {
          kind: "tool",
          text: "",
          key: nextKey(),
          tool: {
            callId: ev.call_id,
            name: ev.name || "tool",
            args: "",
            executor: "server",
            status: ev.is_error ? "error" : "done",
            content: ev.content,
            meta,
            kind,
            ts: row.created_at,
            endTs: row.created_at,
          },
        });
      }
      break;
    }
    case "approval_request": {
      const existing = acc.approvalsByCall.get(ev.call_id);
      if (existing) {
        // Replay of a card already rendered: upsert, not a blind append.
        if (existing.status !== "pending") replaceApproval(acc, existing, { ...existing, status: "pending" });
        break;
      }
      const judge = ev.judge === undefined ? undefined : { reason: ev.judge.reason, ms: ev.judge.ms };
      const a: ApprovalBlock = {
        callId: ev.call_id,
        name: ev.name,
        args: ev.arguments,
        status: "pending",
        ...(judge === undefined ? {} : { judge }),
      };
      acc.approvalsByCall.set(ev.call_id, a);
      append(blocks, { kind: "approval", text: "", approval: a, key: nextKey() });
      break;
    }
    case "approval_decision": {
      const a = acc.approvalsByCall.get(ev.call_id);
      if (!a) break; // orphan decision: the request block carries the story
      if (ev.expired) {
        // An expired card stays: no tool result tells its story — the card
        // itself is the record that the call never ran.
        replaceApproval(acc, a, { ...a, status: "expired", reason: ev.reason ?? undefined });
      } else {
        // A decided approval is not conversation content: the card goes;
        // the denial story lives on in the tool-result frame.
        const i = blocks.findIndex((x) => x.kind === "approval" && x.approval === a);
        if (i >= 0) blocks.splice(i, 1);
        acc.approvalsByCall.delete(ev.call_id);
      }
      break;
    }
    case "compaction":
      // Stream-positioned: at its event position, in order with the
      // messages around it.
      append(blocks, {
        kind: "compaction",
        text: "",
        key: nextKey(),
        compaction: { summary: ev.summary, model: ev.model ?? undefined, keepLast: ev.keep_last ?? null },
      });
      break;
    case "turn_error":
      append(blocks, { kind: "error", text: `Turn failed: ${ev.message}`, key: nextKey() });
      break;
    case "child_spawned":
      append(blocks, {
        kind: "child_spawn",
        text: "",
        key: nextKey(),
        ts: row.created_at,
        childSpawn: {
          threadId: ev.thread_id,
          chatId: ev.chat_id ?? null,
          agentName: ev.agent_name || "Subagent",
          title: ev.title || null,
          task: ev.task || undefined,
          startedAt: row.created_at,
        },
      });
      break;
    case "child_result": {
      const label = spawnLabel(blocks, ev.thread_id);
      append(blocks, {
        kind: "child_result",
        text: "",
        key: nextKey(),
        ts: row.created_at,
        childResult: {
          threadId: ev.thread_id,
          chatId: ev.chat_id ?? label.chatId,
          agentName: ev.agent_name || label.agentName,
          title: ev.title || label.title,
          status: ev.status,
          reason: ev.reason ?? undefined,
          finalText: ev.final_text || undefined,
          startedAt: ev.started_at || undefined,
          finishedAt: row.created_at,
        },
      });
      break;
    }
    case "child_closed":
      append(blocks, {
        kind: "child_closed",
        text: "",
        key: nextKey(),
        ts: row.created_at,
        childClosed: { threadId: ev.thread_id, ...spawnLabel(blocks, ev.thread_id) },
      });
      break;
  }
}

/// Rebuilds the thread view from the persisted thread event log (spec C.3):
/// every row folded in seq order through `foldEvent`. Tool calls, reasoning
/// and text are all resident thread parts — nothing disappears on refresh.
/// Also returns the call-id maps the incremental reducer needs to join
/// later events.
export function deriveThread(rows: ThreadEventRow[]): ThreadFold {
  const acc: ThreadFold = { blocks: [], toolsByCall: new Map(), approvalsByCall: new Map() };
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) foldEvent(acc, row);
  return acc;
}

/// A failed provider attempt's error block is transient: it renders only
/// while it is the thread's LAST block — the current error. Any later
/// content (a retry that landed, a new turn, a queued chip) supersedes it;
/// older errors, including earlier failed attempts of the same turn, never
/// render. Applied wherever blocks are finalized: full derivation, and
/// after every incrementally applied event.
export function pruneStaleErrors(blocks: RenderBlock[]): RenderBlock[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind !== "error") return blocks.filter((b) => b.kind !== "error");
  return blocks.filter((b, i) => i === blocks.length - 1 || b.kind !== "error");
}

export function eventsToBlocks(rows: ThreadEventRow[]): RenderBlock[] {
  return deriveThread(rows).blocks;
}

/// Full-view derivation of one sequenced ThreadState: the durable log plus
/// the authoritative in-flight model buffers. The reducer's first state for
/// a view takes this path; later publishes apply incrementally.
export function threadStateBlocks(state: ThreadState): RenderBlock[] {
  let blocks = eventsToBlocks(state.events);
  if (state.thinking) blocks = upsertThinking(blocks, state.thinking, true, `live-thinking-${state.chat_id}`);
  if (state.text) blocks.push({ kind: "text", text: state.text, key: `unpersisted-${state.chat_id}` });
  return blocks;
}

/// ApprovalRequested inserts a pending card into the current blocks;
/// re-attach replays may fire it again for a card we already render, so
/// this is an upsert, not a blind append.
export function upsertApproval(blocks: RenderBlock[], a: ApprovalBlock): RenderBlock[] {
  const i = blocks.findIndex((x) => x.kind === "approval" && x.approval?.callId === a.callId);
  if (i < 0) return [...blocks, { kind: "approval", text: "", approval: a, key: `approval-${a.callId}` }];
  return blocks.map((x, j) => (j === i ? { ...x, approval: { ...a } } : x));
}

/// Desktop switch-back replay: the fan-out mirror holds every frame since
/// the turn started, while the thread reload already restored the persisted
/// steps. Everything up to the last completed tool call is durable (results
/// persist before the completion broadcasts), so the replay keeps only the
/// in-flight step — the frames after the last tool_completed. Before the
/// turn's first tool completes that is the whole frame list: the reload has
/// none of the turn's text yet.
export function replayFrom<T extends { type: string }>(frames: T[]): T[] {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].type === "tool_completed") return frames.slice(i + 1);
  }
  return frames;
}

/// ApprovalResolved removes the matching card — a decided approval is not
/// conversation content (no-op when it is absent, e.g. the stream resolved
/// before we rendered the request).
export function resolveApproval(
  blocks: RenderBlock[],
  callId: string,
  _approved: boolean,
  _reason?: string,
): RenderBlock[] {
  return blocks.filter((x) => !(x.kind === "approval" && x.approval?.callId === callId));
}

/// Thinking deltas accumulate into the trailing reasoning block. A seed
/// frame carries the FULL in-flight reasoning buffer (spec B.5) right after
/// the durable reload — the in-flight step has no block yet, so the seed
/// starts one; later deltas append to the trailing reasoning block.
function upsertThinking(
  blocks: RenderBlock[],
  content: string,
  seed: boolean,
  seedKey?: string,
  ts?: string,
): RenderBlock[] {
  const last = blocks[blocks.length - 1];
  // A stable key keeps the Frame instance (and its open/collapsed state)
  // alive across views: seed views carry the full buffer, live views
  // append — either way the trailing reasoning block persists. The seed
  // key must be caller-chosen and deterministic: the state feed rebuilds
  // blocks from events every publish (~100ms while thinking streams), and
  // a per-call liveKey() would remount the frame each time, snapping an
  // expanded block shut mid-click.
  if (last?.kind === "reasoning") {
    const text = seed ? content : last.reasoningText + content;
    return [...blocks.slice(0, -1), { ...last, reasoningText: text }];
  }
  return [
    ...blocks,
    {
      kind: "reasoning",
      text: "",
      reasoningText: content,
      ts: ts ?? nowIso(),
      key: seedKey ?? liveKey(),
    },
  ];
}

/** Keeps a pending command visible while a sync races its HTTP request. */
export function reconcilePendingSend(
  rows: ThreadEventRow[],
  blocks: RenderBlock[],
  pending: PendingSend | null,
): RenderBlock[] {
  if (!pending) return blocks;
  const durable = rows.some((row) => row.event.type === "user_message" && row.id === pending.key);
  if (durable) return blocks;
  if (blocks.some((block) => block.key === pending.key)) return blocks;
  return [
    ...blocks,
    {
      kind: "user",
      text: pending.text,
      key: pending.key,
      eventId: pending.key,
      attachments: pending.attachments,
      ts: nowIso(),
      pending: true,
      ...(pending.queued ? { queued: true, queuedMode: pending.queuedMode ?? "queue" } : {}),
    },
  ];
}

// ---------- the reducer ----------

export interface ApplyResult {
  blocks: RenderBlock[];
  /// False when the state's seq was not newer than the view's watermark —
  /// nothing was applied and the caller must not render from it.
  stale: boolean;
  /// True while a compaction runs for the view's chat: the server's
  /// `compacting` flag, or a manual /compact this client sent that the
  /// server has not reported yet. The
  /// guard is data the reducer computes (compaction target vs open chat),
  /// never a chatId comparison in the component body: with a null chatId
  /// a null-vs-null comparison holds and the "Compacting thread…" line
  /// flashes on every first send.
  compacting: boolean;
  /// Whether an authoritative sync has already built this view. A synced
  /// view renders immediately, even when it is empty — a repeat visit must
  /// not flash a skeleton over a known thread.
  synced: boolean;
  /// An older page exists before the view's oldest loaded event.
  hasMore: boolean;
  /// Oldest loaded event seq (-1 = nothing loaded): the cursor for the
  /// next older-page fetch.
  oldestSeq: number;
}

/// One chat's visible-thread state. `watermark` is the last applied
/// ThreadState seq (-1 = nothing yet: the next state derives the full log);
/// `lastEventSeq` is the last applied event row's seq — a state can advance
/// the log watermark without carrying new events, so event application keys
/// off this, not the watermark.
/// `events` is the loaded window of the durable log (ascending): the state's
/// tail plus any older pages the reader scrolled up to load.
interface ChatView {
  blocks: RenderBlock[];
  watermark: number;
  /// Whether an authoritative ThreadState has built this view. A live
  /// thread_events delta can create a view before its first sync (a
  /// background chat's fan-out reaches every socket of the owner); such a
  /// view is not stale-eligible until the sync replaces or merges it.
  synced: boolean;
  lastEventSeq: number;
  events: ThreadEventRow[];
  hasMore: boolean;
  toolsByCall: Map<string, ToolBlock>;
  approvalsByCall: Map<string, ApprovalBlock>;
  /// Compaction block keys present when /compact was sent: a sync adding a
  /// new one is the success signal.
  compactKeys: string[];
}

export interface ThreadReducer {
  /** Switches the open chat. The previous chat's blocks stay cached (LRU,
   * capped) so switching back renders them immediately; `null` opens the
   * no-chat scratch view, empty. */
  open(chatId: string | null): ApplyResult;
  /** Reads one chat's view without switching the open chat (null = the
   * scratch view). The compaction line is reported for that chat. */
  view(chatId: string | null): ApplyResult;
  /** One sequenced ThreadState (initial sync or live publish). Applies only
   * the events past the view's watermark, then re-stamps the authoritative
   * model buffers, settles the pending send and reconciles a manual
   * compaction. Returns `stale` for an out-of-order state. */
  applyState(state: ThreadState): ApplyResult;
  /** One incremental durable-log fan-out (thread_events frame): applies the
   *  fresh rows through the same replay rules a sync uses and advances the
   *  watermark. Never re-stamps buffers — in-flight deltas stay untouched. */
  applyThreadEvents(chatId: string, seq: number, events: ThreadEventRow[]): ApplyResult;
  /** One live stream frame (deltas, tool status, approval cards) for the
   * open chat. Frames render the turn between sequenced states; the next
   * ThreadState re-stamps the buffers they built. */
  applyFrame(frame: StreamEvent): ApplyResult;
  /** Prepends one older page of the durable log (the scroll-to-top loader):
   *  the view re-derives from the merged window, so cross-page tool results
   *  and approval decisions still join their blocks. */
  prependEvents(chatId: string, rows: ThreadEventRow[], hasMore: boolean): ApplyResult;
  /** Forces the next applyState per view to re-derive the full event log
   * (socket reconnect: the fresh sync's events replace the view wholesale,
   * same as a first load). */
  invalidate(): void;
  /** Appends the optimistic user command to its chat's view and registers
   * the pending marker its durable echo settles. */
  optimisticSend(pending: PendingSend): ApplyResult;
  /** Attachment upload finished: `uploadedId` swaps the pending chip id for
   * the stored attachment's (dropping the local preview); without one, only
   * the preview is dropped (upload failed — the file itself is gone). */
  settleAttachment(key: string, pendingId: string, uploadedId?: string): ApplyResult;
  /** The user trashed a queued chip: drops the block (and the pending
   * marker) at once — the server's withdrawal reconcile confirms it for
   * every client via the state republish. */
  dropQueued(chatId: string | null, key: string): ApplyResult;
  /** The send's HTTP request failed: the optimistic block goes, an error
   * block takes its place, and the pending marker is released. */
  failSend(chatId: string | null, key: string, errorText: string): ApplyResult;
  /** Arms (chatId) or disarms (null) the manual-compaction line. Arming
   * snapshots the compaction keys present now; applyState reconciles. */
  setCompacting(chatId: string | null): ApplyResult;
  /** The server accepted the manual compaction: from here a state that
   * reports no compaction running ends the line, with or without a
   * summary. `seq` is the watermark the server reserved after creating the
   * task: a lowered state newer than it, already applied, ends the line
   * now. */
  compactStarted(chatId: string, seq?: number): ApplyResult;
  /** A task outcome clears only its own chat's pending indicator. */
  finishCompacting(chatId: string): ApplyResult;
}

/// Per-chat rendered-view cache cap (switch-back restorations).
const CACHE_LIMIT = 20;

export function createThreadReducer(): ThreadReducer {
  /** Rendered views by chat id; "" is the no-chat scratch view (a failed
   * first send leaves its error block there). */
  const views = new Map<string, ChatView>();
  const LOOSE = "";
  let current = LOOSE;
  /** Chat with a manual /compact in flight that no state has reported yet;
   * null = none. */
  let compactingChat: string | null = null;
  /** The armed /compact's request was accepted by the server. */
  let compactPosted = false;
  /** Newest seq of a state that reported no compaction while the armed
   *  request was still unanswered: the compaction may have settled before
   *  its answer arrived. */
  let compactLoweredSeq: number | null = null;
  /** Chats whose latest state reported a running compaction. */
  const serverCompacting = new Set<string>();
  const compactingOf = (cid: string): boolean => compactingChat === cid || serverCompacting.has(cid);
  /** Optimistic send marker keyed by chat (settled by the durable echo). */
  const pendingByChat = new Map<string, Map<string, PendingSend>>();
  const pendingOf = (cid: string) => {
    let sends = pendingByChat.get(cid);
    if (!sends) {
      sends = new Map();
      pendingByChat.set(cid, sends);
    }
    return sends;
  };

  const freshView = (): ChatView => ({
    blocks: [],
    watermark: -1,
    synced: false,
    lastEventSeq: -1,
    events: [],
    hasMore: false,
    toolsByCall: new Map(),
    approvalsByCall: new Map(),
    compactKeys: [],
  });

  const viewOf = (cid: string): ChatView => {
    let v = views.get(cid);
    if (!v) {
      v = freshView();
      views.set(cid, v);
    }
    return v;
  };

  const result = (v: ChatView, stale = false, synced = true): ApplyResult => ({
    blocks: v.blocks,
    stale,
    compacting: current !== LOOSE && compactingOf(current),
    synced,
    hasMore: v.hasMore,
    oldestSeq: v.events[0]?.seq ?? -1,
  });

  /** Re-derives a view from its loaded event window, carrying the stream
   *  buffers (no durable row yet) and optimistic sends across the rebuild. */
  function rebuild(v: ChatView): void {
    const d = deriveThread(v.events);
    const live: RenderBlock[] = [];
    for (const b of v.blocks) {
      if (b.key.startsWith("unpersisted-") || b.key.startsWith("live-")) {
        live.push(b);
      } else if (
        b.kind === "tool" &&
        b.tool &&
        b.key.startsWith("frame-") &&
        !d.blocks.some((x) => x.kind === "tool" && x.tool?.callId === b.tool?.callId)
      ) {
        live.push(b);
        d.toolsByCall.set(b.tool.callId, b.tool);
      }
    }
    const pending = v.blocks.filter((b) => b.kind === "user" && b.pending && !d.blocks.some((x) => x.key === b.key));
    v.blocks = [...d.blocks, ...live, ...pending];
    v.toolsByCall = d.toolsByCall;
    v.approvalsByCall = d.approvalsByCall;
  }

  function applyEvent(v: ChatView, row: ThreadEventRow): void {
    // A fresh array: the previous one may already be rendering.
    v.blocks = [...v.blocks];
    foldEvent(v, row);
    // The live lanes may have placed blocks after an error; prune keeps an
    // error visible only while it stays the thread's latest block.
    v.blocks = pruneStaleErrors(v.blocks);
  }

  const api: ThreadReducer = {
    open(chatId) {
      const prev = views.get(current);
      if (current !== chatId && prev && prev.blocks.length > 0) {
        if (views.size >= CACHE_LIMIT) {
          const oldest = views.keys().next().value;
          if (oldest !== undefined && oldest !== chatId && oldest !== current && oldest !== LOOSE) {
            views.delete(oldest);
          }
        }
      }
      if (chatId === null) {
        current = LOOSE;
        if (!pendingOf(LOOSE).size) views.set(LOOSE, freshView());
        return result(viewOf(LOOSE), false, false);
      }
      current = chatId;
      const v = viewOf(chatId);
      return result(v, false, v.synced);
    },

    view(chatId) {
      const v = views.get(chatId ?? LOOSE) ?? freshView();
      return {
        blocks: v.blocks,
        stale: false,
        compacting: chatId !== null && compactingOf(chatId),
        synced: v.synced,
        hasMore: v.hasMore,
        oldestSeq: v.events[0]?.seq ?? -1,
      };
    },

    applyState(state) {
      const cid = state.chat_id;
      const v = viewOf(cid);
      // Only a view already built by a sync can call a lower seq stale. A
      // delta-created view has a watermark but no history; dropping the
      // first sync would leave only the delta's few rows rendered.
      if (v.synced && state.seq <= v.watermark) return result(v, true);
      const tailOldest = state.events[0]?.seq ?? Number.POSITIVE_INFINITY;
      const windowIsTail = v.events.length === 0 || (v.events[0]?.seq ?? 0) >= tailOldest;
      if (!v.synced && v.watermark < 0) {
        // A sync re-derives the view from its own window: pages loaded
        // before a reconnect are dropped, because the state's tail may no
        // longer be contiguous with them and a silent gap is worse than
        // re-reading from the tail.
        v.events = state.events;
        v.hasMore = state.has_more_events ?? false;
        rebuild(v);
        v.lastEventSeq = state.events.reduce((max, r) => Math.max(max, r.seq), -1);
      } else if (!v.synced) {
        // The live lane reached this chat before its first sync. Keep both
        // the authoritative window and the newer delta rows, then rebuild.
        const bySeq = new Map<number, ThreadEventRow>();
        for (const r of state.events) bySeq.set(r.seq, r);
        for (const r of v.events) if (!bySeq.has(r.seq)) bySeq.set(r.seq, r);
        v.events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        v.hasMore = state.has_more_events ?? false;
        rebuild(v);
        v.lastEventSeq = v.events.reduce((max, r) => Math.max(max, r.seq), -1);
      } else {
        const fresh = state.events.filter((r) => r.seq > v.lastEventSeq).sort((a, b) => a.seq - b.seq);
        for (const row of fresh) {
          applyEvent(v, row);
          v.lastEventSeq = Math.max(v.lastEventSeq, row.seq);
        }
        if (fresh.length > 0) v.events = [...v.events, ...fresh];
        if (windowIsTail) v.hasMore = state.has_more_events ?? false;
      }
      v.watermark = Math.max(state.seq, v.watermark);
      v.synced = true;
      // The model buffers are authoritative and server-side (commit clears
      // them and lands the assistant_message in one view change): strip the
      // previous buffer blocks, then re-stamp from this state. The strip is
      // by key prefix, not by the two sentinel keys alone: ws stream frames
      // key their blocks per-stream (`live-N` for reasoning segments opened
      // after a text tail, `unpersisted-<chat>` for text), and a commit that
      // only removed the sentinels left those orphans rendering below the
      // durable copies — the response appeared twice.
      // The live-thinking stamp publishes ~10×/s while thinking streams: its
      // replacement carries the ORIGINAL open-time across, or the working
      // card's elapsed clock resets on every publish.
      const liveThinkTs = v.blocks.filter((b) => b.kind === "reasoning" && b.key.startsWith("live-")).at(-1)?.ts;
      let blocks = v.blocks.filter((b) => !b.key.startsWith("unpersisted-") && !b.key.startsWith("live-"));
      if (state.thinking)
        blocks = upsertThinking(blocks, state.thinking, true, `live-thinking-${cid}`, liveThinkTs ?? nowIso());
      if (state.text) blocks = [...blocks, { kind: "text", text: state.text, key: `unpersisted-${cid}` }];
      v.blocks = blocks;
      // Optimistic send: the durable user_message echo (matched by client
      // message id) settles the marker; before it, keep the command visible.
      for (const [key, pending] of pendingOf(cid)) {
        const durable = state.events.some((r) => r.event.type === "user_message" && r.id === key);
        // The server's queue lists the send: its chip comes from there now.
        const queued = state.queue?.some((item) => item.id === key) ?? false;
        if (durable || queued) {
          pendingOf(cid).delete(key);
          v.blocks = v.blocks.filter((b) => !(b.key === key && b.pending));
        } else if (!v.blocks.some((b) => b.key === key)) {
          v.blocks = [
            ...v.blocks,
            {
              kind: "user",
              text: pending.text,
              key,
              eventId: key,
              attachments: pending.attachments,
              pending: true,
              ...(pending.queued ? { queued: true, queuedMode: pending.queuedMode ?? "queue" } : {}),
            },
          ];
        }
      }
      // Queued inputs come from the server's queue. A server that sends no
      // queue marks queued sends on their rows instead.
      v.blocks =
        state.queue !== undefined
          ? syncQueue(v.blocks, state.queue)
          : reconcileQueuedSends(v.blocks, state.events, state.events[0]?.seq);
      // A summary entry can settle the indicator before the task poll returns.
      // Agent generation state is independent of compaction completion.
      if (compactingChat === cid) {
        if (v.blocks.some((b) => b.kind === "compaction" && !v.compactKeys.includes(b.key))) {
          compactingChat = null;
        }
      }
      // The server's flag owns the line once it speaks: a running
      // compaction takes over from the local arm, and a lowered flag after
      // the request was accepted ends it — also when the compaction wrote
      // no summary or failed. A state captured before the request landed
      // cannot lower a fresh arm. Servers that omit the flag leave the
      // summary block as the only end signal.
      if (state.compacting !== undefined) {
        if (state.compacting) serverCompacting.add(cid);
        else serverCompacting.delete(cid);
        if (compactingChat === cid && !state.compacting && !compactPosted) {
          compactLoweredSeq = Math.max(compactLoweredSeq ?? 0, state.seq);
        }
        if (compactingChat === cid && (state.compacting || compactPosted)) compactingChat = null;
      }
      return result(v);
    },

    applyThreadEvents(chatId, seq, events) {
      const v = viewOf(chatId);
      const fresh = events.filter((r) => r.seq > v.lastEventSeq).sort((a, b) => a.seq - b.seq);
      for (const row of fresh) {
        applyEvent(v, row);
        v.lastEventSeq = Math.max(v.lastEventSeq, row.seq);
      }
      if (fresh.length > 0) v.events = [...v.events, ...fresh];
      v.watermark = Math.max(v.watermark, seq);
      return result(v);
    },

    prependEvents(chatId, rows, hasMore) {
      const v = viewOf(chatId);
      const oldest = v.events[0]?.seq ?? Number.POSITIVE_INFINITY;
      const older = rows.filter((r) => r.seq < oldest).sort((a, b) => a.seq - b.seq);
      if (older.length > 0) {
        v.events = [...older, ...v.events];
        rebuild(v);
      }
      v.hasMore = hasMore;
      return result(v);
    },

    applyFrame(frame) {
      const v = viewOf(current);
      switch (frame.type) {
        case "thinking_delta":
          v.blocks = upsertThinking(v.blocks, frame.content ?? "", false);
          break;
        case "delta": {
          const last = v.blocks[v.blocks.length - 1];
          if (last?.kind === "text" && last.key === `unpersisted-${current}`) {
            v.blocks = [...v.blocks.slice(0, -1), { ...last, text: last.text + (frame.content ?? "") }];
          } else {
            v.blocks = [...v.blocks, { kind: "text", text: frame.content ?? "", key: `unpersisted-${current}` }];
          }
          break;
        }
        case "tool_started": {
          const tb = frame.call_id ? v.toolsByCall.get(frame.call_id) : undefined;
          if (tb) {
            const next = { ...tb, status: "running" as const, ts: tb.ts ?? nowIso() };
            v.toolsByCall.set(tb.callId, next);
            v.blocks = v.blocks.map((b) => (b.kind === "tool" && b.tool === tb ? { ...b, tool: next } : b));
          } else if (frame.call_id) {
            // The row's carrying assistant step fans out through the event
            // lane a beat later: provision the block now so the call shows
            // the moment it starts (applyEvent adopts it — no duplicate).
            const fresh: ToolBlock = {
              callId: frame.call_id,
              name: frame.name ?? "tool",
              args: frame.arguments ?? "",
              executor: frame.executor === "client" ? "client" : "server",
              status: "running",
              ts: nowIso(),
            };
            v.toolsByCall.set(frame.call_id, fresh);
            v.blocks = [...v.blocks, { kind: "tool", text: "", tool: fresh, key: `frame-${frame.call_id}` }];
          }
          break;
        }
        case "tool_completed": {
          const tb = frame.call_id ? v.toolsByCall.get(frame.call_id) : undefined;
          if (tb) {
            const next = {
              ...tb,
              status: frame.is_error ? ("error" as const) : ("done" as const),
              content: frame.content ?? tb.content,
              endTs: nowIso(),
            };
            v.toolsByCall.set(tb.callId, next);
            v.blocks = v.blocks.map((b) => (b.kind === "tool" && b.tool === tb ? { ...b, tool: next } : b));
          } else if (frame.call_id) {
            // A fast tool's completion frame can beat the anchor event's
            // notify fan-out: provision the finished row here — the durable
            // assistant_message adopts it (no duplicate). The completion frame
            // carries no executor; `tool_started` is its source. Default to
            // the server, which is where every tool runs unless it is client.
            const fresh: ToolBlock = {
              callId: frame.call_id,
              name: frame.name,
              args: "",
              executor: "server",
              status: frame.is_error ? "error" : "done",
              content: frame.content,
              ts: nowIso(),
              endTs: nowIso(),
            };
            v.toolsByCall.set(frame.call_id, fresh);
            v.blocks = [...v.blocks, { kind: "tool", text: "", tool: fresh, key: `frame-${frame.call_id}` }];
          }
          break;
        }
        case "approval_requested":
          v.blocks = upsertApproval(v.blocks, {
            callId: frame.call_id ?? "",
            name: frame.name ?? "tool",
            args: frame.arguments ?? "",
            status: "pending",
          });
          break;
        case "approval_resolved":
          v.blocks = resolveApproval(v.blocks, frame.call_id ?? "", !!frame.approved, frame.reason);
          break;
      }
      return result(v);
    },

    invalidate() {
      for (const v of views.values()) {
        v.watermark = -1;
        v.synced = false;
        // The reconnect sync replaces the window wholesale; dropping it now
        // keeps a delta that lands before that sync from merging old pages.
        v.events = [];
        v.lastEventSeq = -1;
      }
    },

    optimisticSend(pending) {
      const v = viewOf(pending.chatId ?? LOOSE);
      v.blocks = [
        ...v.blocks.filter((b) => b.key !== pending.key),
        {
          kind: "user",
          text: pending.text,
          pending: true,
          key: pending.key,
          eventId: pending.key,
          attachments: pending.attachments,
          ts: nowIso(),
          ...(pending.queued ? { queued: true, queuedMode: pending.queuedMode ?? "queue" } : {}),
        },
      ];
      pendingOf(pending.chatId ?? LOOSE).set(pending.key, pending);
      return result(v);
    },

    settleAttachment(key, pendingId, uploadedId) {
      const update = (attachments: PendingSend["attachments"]) =>
        attachments?.map((a) =>
          a.id === pendingId ? { ...a, ...(uploadedId ? { id: uploadedId, previewUrl: undefined } : {}) } : a,
        );
      for (const sends of pendingByChat.values()) {
        const pending = sends.get(key);
        if (pending) sends.set(key, { ...pending, attachments: update(pending.attachments) });
      }
      for (const v of views.values()) {
        v.blocks = v.blocks.map((b) =>
          b.key === key && b.kind === "user" ? { ...b, attachments: update(b.attachments) } : b,
        );
      }
      return result(viewOf(current));
    },

    dropQueued(chatId, key) {
      const target = chatId ?? LOOSE;
      pendingOf(target).delete(key);
      const v = viewOf(target);
      v.blocks = v.blocks.filter((b) => !(b.key === key || (b.kind === "user" && b.eventId === key)));
      return result(viewOf(current));
    },

    failSend(chatId, key, errorText) {
      const v = viewOf(chatId ?? LOOSE);
      pendingOf(chatId ?? LOOSE).delete(key);
      v.blocks = [...v.blocks.filter((b) => b.key !== key), { kind: "error", text: errorText, key: liveKey() }];
      return result(v);
    },

    setCompacting(chatId) {
      if (chatId === null) {
        compactingChat = null;
      } else {
        const v = viewOf(chatId);
        v.compactKeys = v.blocks.filter((b) => b.kind === "compaction").map((b) => b.key);
        compactingChat = chatId;
      }
      compactPosted = false;
      compactLoweredSeq = null;
      return result(viewOf(current));
    },
    compactStarted(chatId, seq) {
      if (compactingChat !== chatId) return result(viewOf(current));
      // A state captured after the task existed already said it was over.
      if (seq !== undefined && compactLoweredSeq !== null && compactLoweredSeq > seq) compactingChat = null;
      else compactPosted = true;
      return result(viewOf(current));
    },
    finishCompacting(chatId) {
      if (compactingChat === chatId) {
        compactingChat = null;
        compactPosted = false;
      }
      return result(viewOf(current));
    },
  };
  return api;
}
