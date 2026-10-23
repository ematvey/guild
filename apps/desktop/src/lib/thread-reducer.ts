//! Thread reducer: the single source of the merge rules turning the durable
//! event log, the live model buffers and the optimistic send path into the
//! visible blocks a chat view renders. Per-chat state ({blocks, watermark,
//! pending send, compaction keys}) advances incrementally — a sequenced
//! ThreadState publish applies only its new events and re-stamps the buffer
//! blocks, never re-deriving the whole thread per streaming frame.
//!
//! Boundary: visible blocks only. Sockets, transport and composer state
//! stay in the component; this is a plain module, not a store.

import type {
  MessageAttachmentMeta,
  StreamFrame,
  ThreadEvent,
  ThreadEventRow,
  ThreadState,
} from "../transport";

// ---------- block shapes ----------

export interface ChildRow {
  /** The child agent thread id (the child_result event's thread_id). */
  threadId: string;
  runId?: string;
  /** The durable chat id the child thread projects into; the row opens this
   *  chat at its canonical /thread/<chatId> address. Null when no event
   *  supplied one. */
  chatId?: string | null;
  agentName: string;
  /** The session name its spawner chose; the row shows it first. */
  title?: string | null;
  status: string;
  reason?: string;
  startedAt: string;
  finishedAt?: string;
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

/** Child metadata from a child_spawned event: the row exists as soon as the
 *  spawn posts the child turn, before the child finishes. */
function childRowFromSpawned(
  ev: {
    thread_id: string;
    run_id: string;
    chat_id?: string | null;
    agent_name?: string | null;
    title?: string | null;
    status: string;
  },
  createdAt: string,
): ChildRow {
  return {
    threadId: ev.thread_id,
    runId: ev.run_id,
    chatId: ev.chat_id ?? null,
    agentName: ev.agent_name || "Subagent",
    title: ev.title || null,
    status: ev.status,
    startedAt: createdAt,
  };
}

/** The fallback row for a child_result with no child_spawned row in the
 *  loaded window. Only the event's chat_id can open a chat; a thread id is
 *  never a chat id. */
function childRowFromResult(
  ev: {
    thread_id: string;
    chat_id?: string | null;
    agent_name?: string | null;
    title?: string | null;
    run_id: string;
    status: string;
    reason?: string | null;
    started_at?: string | null;
  },
  createdAt: string,
): ChildRow {
  return {
    threadId: ev.thread_id,
    runId: ev.run_id,
    chatId: ev.chat_id ?? null,
    agentName: ev.agent_name || "Subagent",
    title: ev.title || null,
    status: ev.status,
    reason: ev.reason ?? undefined,
    startedAt: ev.started_at || createdAt,
    finishedAt: createdAt,
  };
}

function upsertChild(children: ChildRow[], row: ChildRow): ChildRow[] {
  const index = children.findIndex((child) => child.threadId === row.threadId);
  if (index < 0) return [...children, row];
  const current = children[index]!;
  return children.map((child, i) => (i === index ? { ...current, ...row } : child));
}

function applyChildSpawned(children: ChildRow[], ev: Extract<ThreadEvent, { type: "child_spawned" }>, createdAt: string): ChildRow[] {
  return upsertChild(children, childRowFromSpawned(ev, createdAt));
}

function applyChildResult(children: ChildRow[], ev: Extract<ThreadEvent, { type: "child_result" }>, createdAt: string): ChildRow[] {
  const index = children.findIndex((child) => child.threadId === ev.thread_id);
  if (index < 0) return [...children, childRowFromResult(ev, createdAt)];
  const current = children[index]!;
  return children.map((child, i) =>
    i === index
      ? {
          ...current,
          chatId: current.chatId ?? ev.chat_id ?? null,
          runId: ev.run_id,
          agentName: ev.agent_name || current.agentName,
          title: ev.title || current.title,
          status: ev.status,
          reason: ev.reason ?? undefined,
          startedAt: ev.started_at || current.startedAt,
          finishedAt: createdAt,
        }
      : child,
  );
}

/// A close of a row the window never spawned is ignored: it must not
/// invent a row.
function applyChildClosed(children: ChildRow[], ev: Extract<ThreadEvent, { type: "child_closed" }>, createdAt: string): ChildRow[] {
  const index = children.findIndex((child) => child.threadId === ev.thread_id);
  if (index < 0) return children;
  return children.map((child, i) =>
    i === index ? { ...child, status: "closed", finishedAt: createdAt } : child,
  );
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
  const meta = t.meta as Partial<ArtifactCard> & { card?: unknown; kind?: unknown } | null | undefined;
  if (!meta || typeof meta !== "object") return null;
  const nested = (meta.card ?? null) as Partial<ArtifactCard> & { card?: unknown; kind?: unknown } | null;
  const a =
    (meta.card === "artifact" || meta.kind === "artifact")
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

export interface Block {
  kind: "user" | "text" | "error" | "reasoning" | "tool" | "approval" | "compaction";
  text: string;
  /// Stable React key. Derived blocks use the source event's seq (plus an
  /// in-event index); streaming-built blocks use a live counter.
  key: string;
  /// kind === "user": the backing thread-event id (the turn command id —
  /// delivery/withdrawal reconcile matches blocks by it, not by key: a
  /// delivered queued send MOVES to a fresh seq).
  eventId?: string;
  /// kind === "user": context attachment chips (metadata only; images may
  /// carry a local preview URL for optimistic rendering).
  attachments?: (MessageAttachmentMeta & { previewUrl?: string })[];
  /// An optimistic user command not yet present in the durable history.
  pending?: boolean;
  /// Admitted while a turn was generating: not yet seen by the model —
  /// rendered as a queued chip above the composer, not a transcript bubble,
  /// until the inbox places it (the server clears the flag at placement).
  queued?: boolean;
  /// Requested placement for the same chip: "steer" | "queue".
  queuedMode?: "steer" | "queue";
  /// kind === "reasoning": the accumulated thinking text.
  reasoningText?: string;
  /// kind === "text": the turn was stopped mid-stream; the text is the
  /// delivered prefix.
  interrupted?: boolean;
  /// Event timestamp (ISO): when this block's source event row landed —
  /// the working card's timeline anchor. Stream-built blocks stamp the
  /// frame's arrival instead (kept across the re-stamp, never reset).
  ts?: string;
  tool?: ToolBlock;
  approval?: ApprovalBlock;
  compaction?: CompactionBlock;
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
function queuedFieldsOf(ev: { queued?: boolean; mode?: "steer" | "queue" }): {
  queued?: boolean;
  queuedMode?: "steer" | "queue";
} {
  return ev.queued ? { queued: true, queuedMode: ev.mode ?? "queue" } : {};
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
  blocks: Block[],
  rows: ThreadEventRow[],
  /// Seq of the authoritative window's oldest row: a block older than this
  /// came from a loaded earlier page, and a queued row can never be that
  /// old, so it is neither withdrawn nor re-stamped.
  windowOldest = Number.NEGATIVE_INFINITY,
): Block[] {
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
    if (!!b.queued === (row.event.queued === true) && (!row.event.queued || b.queuedMode === (row.event.mode ?? "queue"))) return [b];
    return [{ ...b, ...clearedQueuedFields(), ...(row.event.queued ? { queued: true, queuedMode: row.event.mode ?? "queue" } : {}) }];
  });
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
const CLIENT_TOOL_NAMES = [
  "read_file",
  "execute",
  "edit_file",
  "write_file",
];

interface DerivedThread {
  blocks: Block[];
  children: ChildRow[];
  toolsByCall: Map<string, ToolBlock>;
  approvalsByCall: Map<string, ApprovalBlock>;
}

/// Rebuilds the thread view from the persisted thread event log (spec C.3).
/// Tool calls, reasoning and text are all resident thread parts — nothing
/// disappears on refresh: every assistant block is replayed in stream order
/// and tool results fill their matching frames. Also returns the call-id
/// maps the incremental reducer needs to join later events.
export function deriveThread(rows: ThreadEventRow[]): DerivedThread {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const blocks: Block[] = [];
  let children: ChildRow[] = [];
  const toolsByCall = new Map<string, ToolBlock>();
  const approvalsByCall = new Map<string, ApprovalBlock>();
  for (const row of sorted) {
    const ev = row.event;
    const seqKey = (n: number) => `${row.seq}:${n}`;
    let inEvent = 0;
    switch (ev.type) {
      case "user_message": {
        // Event content is the model-facing turn: typed text plus inlined
        // "[Attachment: …]" blocks, plus the skill-invocation block the
        // client expanded for `/name` mentions. Show the typed text; the
        // model-facing payloads stay in the event.
        const at = ev.content.indexOf("\n\n[Attachment: ");
        const inv = ev.content.indexOf("\n\n---\nInvoked skills");
        const cut = [at, inv].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
        blocks.push({
          kind: "user",
          text: cut >= 0 ? ev.content.slice(0, cut) : ev.content,
          attachments: ev.attachments,
          eventId: row.id,
          ...queuedFieldsOf(ev),
          ts: row.created_at,
          key: seqKey(inEvent++),
        });
        break;
      }
      case "system_message":
        break; // server-owned prompt, log-only
      case "assistant_message": {
        const start = blocks.length;
        for (const b of ev.blocks) {
          if (b.type === "reasoning") {
            blocks.push({ kind: "reasoning", text: "", reasoningText: b.text, ts: row.created_at, key: seqKey(inEvent++) });
          } else if (b.type === "text") {
            blocks.push({ kind: "text", text: b.text, ts: row.created_at, key: seqKey(inEvent++) });
          } else {
            const tb: ToolBlock = {
              callId: b.id,
              name: b.name,
              args: b.arguments,
              executor: CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server",
              status: "done", // filled by the matching tool_result below
              ts: row.created_at,
            };
            toolsByCall.set(b.id, tb);
            blocks.push({ kind: "tool", text: "", tool: tb, key: seqKey(inEvent++) });
          }
        }
        if (ev.interrupted) {
          for (let j = blocks.length - 1; j >= start; j--) {
            if (blocks[j].kind === "text") {
              blocks[j].interrupted = true;
              break;
            }
          }
        }
        if (ev.error) {
          blocks.push({ kind: "error", text: ev.error, key: seqKey(inEvent++) });
        }
        break;
      }
      case "tool_result": {
        const meta = (ev.meta ?? undefined) as ToolMeta | undefined;
        const kind = (ev as { kind?: string | null }).kind ?? undefined;
        const tb = toolsByCall.get(ev.call_id);
        if (tb) {
          tb.content = ev.content;
          tb.status = ev.is_error ? "error" : "done";
          tb.meta = meta;
          tb.kind = kind;
          tb.endTs = row.created_at;
        } else {
          // Orphan result (call block missing): render it anyway rather than drop it.
          const orphan: ToolBlock = {
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
          };
          blocks.push({
            kind: "tool",
            text: "",
            tool: orphan,
            key: seqKey(inEvent++),
          });
        }
        break;
      }
      case "approval_request": {
        const a: ApprovalBlock = {
          callId: ev.call_id,
          name: ev.name,
          args: ev.arguments,
          status: "pending", // flipped by the matching decision below
        };
        approvalsByCall.set(ev.call_id, a);
        blocks.push({ kind: "approval", text: "", approval: a, key: seqKey(inEvent++) });
        break;
      }
      case "approval_decision": {
        const a = approvalsByCall.get(ev.call_id);
        if (a) {
          a.status = ev.expired ? "expired" : ev.approved ? "approved" : "denied";
          a.reason = ev.reason ?? undefined;
        }
        break; // orphan decision: the request block carries the story
      }
      case "compaction":
        // Stream-positioned: pushed at its event position, in order with the
        // messages around it.
        blocks.push({
          kind: "compaction",
          text: "",
          key: seqKey(inEvent++),
          compaction: {
            summary: ev.summary,
            model: ev.model ?? undefined,
            keepLast: ev.keep_last ?? null,
          },
        });
        break;
      case "turn_error":
        blocks.push({ kind: "error", text: `Turn failed: ${ev.message}`, key: seqKey(inEvent++) });
        break;
      case "child_spawned":
        children = applyChildSpawned(children, ev, row.created_at);
        break;
      case "child_result":
        children = applyChildResult(children, ev, row.created_at);
        break;
      case "child_closed":
        children = applyChildClosed(children, ev, row.created_at);
        break;
    }
  }
  // Resolved approvals are decisions, not conversation content: a card whose
  // decision event arrived is dropped, so history renders only approvals
  // still waiting for an answer. Expired cards stay: no tool result tells
  // their story — the card itself is the record that the call never ran.
  return {
    blocks: pruneStaleErrors(
      blocks.filter(
        (b) =>
          !(
            b.kind === "approval" &&
            b.approval &&
            (b.approval.status === "approved" || b.approval.status === "denied")
          ),
      ),
    ),
    children,
    toolsByCall,
    approvalsByCall,
  };
}

/// A failed provider attempt's error block is transient: it renders only
/// while it is the thread's LAST block — the current error. Any later
/// content (a retry that landed, a new turn, a queued chip) supersedes it;
/// older errors, including earlier failed attempts of the same turn, never
/// render. Applied wherever blocks are finalized: full derivation, and
/// after every incrementally applied event.
export function pruneStaleErrors(blocks: Block[]): Block[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind !== "error") return blocks.filter((b) => b.kind !== "error");
  return blocks.filter((b, i) => i === blocks.length - 1 || b.kind !== "error");
}

export function eventsToBlocks(rows: ThreadEventRow[]): Block[] {
  return deriveThread(rows).blocks;
}

/// Full-view derivation of one sequenced ThreadState: the durable log plus
/// the authoritative in-flight model buffers. The reducer's first state for
/// a view takes this path; later publishes apply incrementally.
export function threadStateBlocks(state: ThreadState): Block[] {
  let blocks = eventsToBlocks(state.events);
  if (state.thinking)
    blocks = upsertThinking(blocks, state.thinking, true, `live-thinking-${state.chat_id}`);
  if (state.text) blocks.push({ kind: "text", text: state.text, key: `unpersisted-${state.chat_id}` });
  return blocks;
}

/// ApprovalRequested inserts a pending card into the current blocks;
/// re-attach replays may fire it again for a card we already render, so
/// this is an upsert, not a blind append.
export function upsertApproval(blocks: Block[], a: ApprovalBlock): Block[] {
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
export function replayFrom(frames: StreamFrame[]): StreamFrame[] {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].type === "tool_completed") return frames.slice(i + 1);
  }
  return frames;
}

/// ApprovalResolved removes the matching card — a decided approval is not
/// conversation content (no-op when it is absent, e.g. the stream resolved
/// before we rendered the request).
export function resolveApproval(
  blocks: Block[],
  callId: string,
  _approved: boolean,
  _reason?: string,
): Block[] {
  return blocks.filter((x) => !(x.kind === "approval" && x.approval?.callId === callId));
}

/// Thinking deltas accumulate into the trailing reasoning block. A seed
/// frame carries the FULL in-flight reasoning buffer (spec B.5) right after
/// the durable reload — the in-flight step has no block yet, so the seed
/// starts one; later deltas append to the trailing reasoning block.
function upsertThinking(
  blocks: Block[],
  content: string,
  seed: boolean,
  seedKey?: string,
  ts?: string,
): Block[] {
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
  blocks: Block[],
  pending: PendingSend | null,
): Block[] {
  if (!pending) return blocks;
  const durable = rows.some(row => row.event.type === "user_message" && row.id === pending.key);
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
  blocks: Block[];
  children: ChildRow[];
  /// False when the state's seq was not newer than the view's watermark —
  /// nothing was applied and the caller must not render from it.
  stale: boolean;
  /// True while a manual /compact is in flight for the view's chat. The
  /// guard is data the reducer computes (compaction target vs open chat),
  /// never a chatId comparison in the component body: with a null chatId
  /// a null-vs-null comparison holds and the "Compacting thread…" line
  /// flashes on every first send.
  compacting: boolean;
  /// open()/adopt(): whether the view already held content (a cached thread
  /// renders immediately — no loading skeleton over known blocks). Always
  /// true on the other transitions.
  restored: boolean;
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
  blocks: Block[];
  children: ChildRow[];
  watermark: number;
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
  /** First send: the created chat adopts the scratch view's optimistic
   * block; the socket's first ThreadState continues from there. */
  adopt(chatId: string): ApplyResult;
  /** One sequenced ThreadState (initial sync or live publish). Applies only
   * the events past the view's watermark, then re-stamps the authoritative
   * model buffers, settles the pending send and reconciles a manual
   * compaction. Returns `stale` for an out-of-order state. */
  applyState(state: ThreadState): ApplyResult;
  /** One incremental durable-log fan-out (thread_events frame): applies the
   *  fresh rows through the same replay rules a sync uses and advances the
   *  watermark. Never re-stamps buffers — in-flight deltas stay untouched. */
  applyThreadEvents(chatId: string, seq: number, events: ThreadEventRow[]): ApplyResult;
  /** One live stream frame (deltas, tool status, approval cards). The wire
   * contract keeps view content sequenced-ThreadState-only (LiveFrames are
   * a non-replayable command-consumer stream), so the chat view does not
   * feed frames today; the transition exists for stream consumers built on
   * the same merge rules. */
  applyFrame(frame: StreamFrame): ApplyResult;
  /** Prepends one older page of the durable log (the scroll-to-top loader):
   *  the view re-derives from the merged window, so cross-page tool results
   *  and approval decisions still join their blocks. */
  prependEvents(chatId: string, rows: ThreadEventRow[], hasMore: boolean): ApplyResult;
  /** Forces the next applyState per view to re-derive the full event log
   * (socket reconnect: the fresh sync's events replace the view wholesale,
   * same as a first load). */
  invalidate(): void;
  /** Appends the optimistic user command to the current view; a send to an
   * existing chat registers the pending marker here, a first send binds it
   * later via bindPending. */
  optimisticSend(pending: PendingSend): ApplyResult;
  /** Binds a first send's pending marker to the chat created for it. */
  bindPending(chatId: string, key: string): void;
  /** Attachment upload finished: `uploadedId` swaps the pending chip id for
   * the stored attachment's (dropping the local preview); without one, only
   * the preview is dropped (upload failed — the file itself is gone). */
  settleAttachment(key: string, pendingId: string, uploadedId?: string): ApplyResult;
  /** Appends an error block to the current view (create-chat failure,
   * attachment upload failure). */
  appendError(text: string): ApplyResult;
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
  /** A task outcome clears only its own chat's pending indicator. */
  finishCompacting(chatId: string): ApplyResult;
}

/// Per-chat rendered-view cache cap (switch-back restorations).
const CACHE_LIMIT = 20;

export function createThreadReducer(): ThreadReducer {
  /** Rendered views by chat id; "" is the no-chat scratch view (a first
   * send's optimistic block lives there until the created chat adopts it). */
  const views = new Map<string, ChatView>();
  const LOOSE = "";
  let current = LOOSE;
  /** Chat with a manual /compact in flight; null = none. */
  let compactingChat: string | null = null;
  /** Optimistic send marker keyed by chat (settled by the durable echo). */
  const pendingByChat = new Map<string, Map<string, PendingSend>>();
  const pendingOf = (cid: string) => {
    let sends = pendingByChat.get(cid);
    if (!sends) { sends = new Map(); pendingByChat.set(cid, sends); }
    return sends;
  };

  const freshView = (): ChatView => ({
    blocks: [],
    children: [],
    watermark: -1,
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

  const result = (v: ChatView, stale = false, restored = true): ApplyResult => ({
    blocks: v.blocks,
    children: v.children,
    stale,
    compacting: compactingChat !== null && current !== LOOSE && compactingChat === current,
    restored,
    hasMore: v.hasMore,
    oldestSeq: v.events[0]?.seq ?? -1,
  });

  /** Re-derives a view from its loaded event window, carrying the stream
   *  buffers (no durable row yet) and optimistic sends across the rebuild. */
  function rebuild(v: ChatView): void {
    const d = deriveThread(v.events);
    const live: Block[] = [];
    for (const b of v.blocks) {
      if (b.key.startsWith("unpersisted-") || b.key.startsWith("live-")) {
        live.push(b);
      } else if (b.kind === "tool" && b.tool && b.key.startsWith("frame-") && !d.blocks.some(
        (x) => x.kind === "tool" && x.tool?.callId === b.tool?.callId,
      )) {
        live.push(b);
        d.toolsByCall.set(b.tool.callId, b.tool);
      }
    }
    const pending = v.blocks.filter(
      (b) => b.kind === "user" && b.pending && !d.blocks.some((x) => x.key === b.key),
    );
    v.blocks = [...d.blocks, ...live, ...pending];
    v.children = d.children;
    v.toolsByCall = d.toolsByCall;
    v.approvalsByCall = d.approvalsByCall;
  }

  function applyEvent(v: ChatView, row: ThreadEventRow): void {
    const ev = row.event;
    const seqKey = (n: number) => `${row.seq}:${n}`;
    switch (ev.type) {
      case "user_message": {
        const at = ev.content.indexOf("\n\n[Attachment: ");
        const inv = ev.content.indexOf("\n\n---\nInvoked skills");
        const cut = [at, inv].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
        // Delivery of a queued send MOVES the echo to a fresh seq: a block
        // for this event id already renders (the queued chip) — reposition
        // it at the placement point (array end = seq order here) with the
        // placement flags reconciled, instead of appending a twin. A mode
        // update can move its seq while the input is still queued.
        const existing = v.blocks.find((b) => b.kind === "user" && b.eventId === row.id);
        if (existing) {
          v.blocks = [
            ...v.blocks.filter((b) => b !== existing),
            {
              ...existing,
              text: cut >= 0 ? ev.content.slice(0, cut) : ev.content,
              attachments: ev.attachments,
              key: seqKey(0),
              ts: row.created_at,
              pending: false,
              ...clearedQueuedFields(),
              ...queuedFieldsOf(ev),
            },
          ];
          break;
        }
        v.blocks.push({
          kind: "user",
          text: cut >= 0 ? ev.content.slice(0, cut) : ev.content,
          attachments: ev.attachments,
          eventId: row.id,
          ...queuedFieldsOf(ev),
          ts: row.created_at,
          key: seqKey(0),
        });
        break;
      }
      case "system_message":
        break; // server-owned prompt, log-only
      case "assistant_message": {
        // This step's streamed buffers are now durable: the live reasoning
        // block the deltas built (stream frames / the state stamp) and the
        // trailing streamed text are superseded by this event's blocks —
        // drop them or the step renders twice (the fan-out lane has no
        // ThreadState publish behind it to strip the buffers). The live
        // block's open-time carries onto its durable successor, or the
        // working card's elapsed clock resets at every commit.
        const liveThinkTs = v.blocks
          .filter((b) => b.kind === "reasoning" && b.key.startsWith("live-"))
          .at(-1)?.ts;
        v.blocks = v.blocks.filter(
          (b) =>
            !(b.kind === "reasoning" && b.key.startsWith("live-")) &&
            !(b.kind === "text" && b.key.startsWith("unpersisted-")),
        );
        const start = v.blocks.length;
        let reasoningSeen = false;
        for (const b of ev.blocks) {
          if (b.type === "reasoning") {
            v.blocks.push({
              kind: "reasoning",
              text: "",
              reasoningText: b.text,
              ts: !reasoningSeen && liveThinkTs ? liveThinkTs : row.created_at,
              key: seqKey(v.blocks.length - start),
            });
            reasoningSeen = true;
          } else if (b.type === "text") {
            v.blocks.push({ kind: "text", text: b.text, ts: row.created_at, key: seqKey(v.blocks.length - start) });
          } else {
            // A live tool_started frame may have provisioned this row before
            // the carrying message fanned out: adopt it instead of pushing a
            // duplicate block (its arrival stamp is the call's true start).
            const existing = v.toolsByCall.get(b.id);
            if (existing) {
              existing.name = b.name;
              existing.args = b.arguments;
              existing.executor = CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server";
              existing.ts = existing.ts ?? row.created_at;
            } else {
              const tb: ToolBlock = {
                callId: b.id,
                name: b.name,
                args: b.arguments,
                executor: CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server",
                status: "done",
                ts: row.created_at,
              };
              v.toolsByCall.set(b.id, tb);
              v.blocks.push({ kind: "tool", text: "", tool: tb, key: seqKey(v.blocks.length - start) });
            }
          }
        }
        if (ev.interrupted) {
          for (let j = v.blocks.length - 1; j >= start; j--) {
            if (v.blocks[j].kind === "text") {
              v.blocks[j].interrupted = true;
              break;
            }
          }
        }
        if (ev.error) {
          v.blocks.push({ kind: "error", text: ev.error, key: seqKey(0) });
        }
        break;
      }
      case "tool_result": {
        const meta = (ev.meta ?? undefined) as ToolMeta | undefined;
        const kind = (ev as { kind?: string | null }).kind ?? undefined;
        const tb = v.toolsByCall.get(ev.call_id);
        if (tb) {
          tb.content = ev.content;
          tb.status = ev.is_error ? "error" : "done";
          tb.meta = meta;
          tb.kind = kind;
          tb.endTs = row.created_at;
        } else {
          const orphan: ToolBlock = {
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
          };
          v.blocks.push({
            kind: "tool",
            text: "",
            tool: orphan,
            key: seqKey(0),
          });
        }
        break;
      }
      case "approval_request": {
        const existing = v.approvalsByCall.get(ev.call_id);
        if (existing) {
          // Replay of a card we already render: upsert, not a blind append.
          existing.status = "pending";
          break;
        }
        const a: ApprovalBlock = {
          callId: ev.call_id,
          name: ev.name,
          args: ev.arguments,
          status: "pending",
        };
        v.approvalsByCall.set(ev.call_id, a);
        v.blocks.push({ kind: "approval", text: "", approval: a, key: seqKey(0) });
        break;
      }
      case "approval_decision": {
        const a = v.approvalsByCall.get(ev.call_id);
        if (!a) break; // orphan decision: the request block carries the story
        if (ev.expired) {
          a.status = "expired";
          a.reason = ev.reason ?? undefined;
        } else {
          // A decided approval is not conversation content: the card goes;
          // the denial story lives on in the tool-result frame.
          v.blocks = v.blocks.filter((x) => !(x.kind === "approval" && x.approval === a));
          v.approvalsByCall.delete(ev.call_id);
        }
        break;
      }
      case "compaction":
        v.blocks.push({
          kind: "compaction",
          text: "",
          key: seqKey(0),
          compaction: {
            summary: ev.summary,
            model: ev.model ?? undefined,
            keepLast: ev.keep_last ?? null,
          },
        });
        break;
      case "turn_error":
        v.blocks.push({ kind: "error", text: `Turn failed: ${ev.message}`, key: seqKey(0) });
        break;
      case "child_spawned":
        v.children = applyChildSpawned(v.children, ev, row.created_at);
        break;
      case "child_result":
        v.children = applyChildResult(v.children, ev, row.created_at);
        break;
      case "child_closed":
        v.children = applyChildClosed(v.children, ev, row.created_at);
        break;
    }
    // A new event supersedes a shown error: prune keeps the error visible
    // only while it stays the thread's latest block.
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
      return result(v, false, v.blocks.length > 0);
    },

    adopt(chatId) {
      current = chatId;
      return result(viewOf(chatId));
    },

    applyState(state) {
      const cid = state.chat_id;
      const v = viewOf(cid);
      if (state.seq <= v.watermark) return result(v, true);
      const tailOldest = state.events[0]?.seq ?? Number.POSITIVE_INFINITY;
      const windowIsTail = v.events.length === 0 || (v.events[0]?.seq ?? 0) >= tailOldest;
      if (v.watermark < 0) {
        // A sync re-derives the view from its own window: pages loaded
        // before a reconnect are dropped, because the state's tail may no
        // longer be contiguous with them and a silent gap is worse than
        // re-reading from the tail.
        v.events = state.events;
        v.hasMore = state.has_more_events ?? false;
        rebuild(v);
        v.lastEventSeq = state.events.reduce((max, r) => Math.max(max, r.seq), -1);
      } else {
        const fresh = state.events
          .filter((r) => r.seq > v.lastEventSeq)
          .sort((a, b) => a.seq - b.seq);
        for (const row of fresh) {
          applyEvent(v, row);
          v.lastEventSeq = Math.max(v.lastEventSeq, row.seq);
        }
        if (fresh.length > 0) v.events = [...v.events, ...fresh];
        if (windowIsTail) v.hasMore = state.has_more_events ?? false;
      }
      v.watermark = state.seq;
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
      const liveThinkTs = v.blocks
        .filter((b) => b.kind === "reasoning" && b.key.startsWith("live-"))
        .at(-1)?.ts;
      let blocks = v.blocks.filter(
        (b) => !b.key.startsWith("unpersisted-") && !b.key.startsWith("live-"),
      );
      if (state.thinking)
        blocks = upsertThinking(blocks, state.thinking, true, `live-thinking-${cid}`, liveThinkTs ?? nowIso());
      if (state.text)
        blocks = [...blocks, { kind: "text", text: state.text, key: `unpersisted-${cid}` }];
      v.blocks = blocks;
      // Optimistic send: the durable user_message echo (matched by client
      // message id) settles the marker; before it, keep the command visible.
      for (const [key, pending] of pendingOf(cid)) {
        const durable = state.events.some(r => r.event.type === "user_message" && r.id === key);
        if (durable) {
          pendingOf(cid).delete(key);
          v.blocks = v.blocks.filter(b => !(b.key === key && b.pending));
        } else if (!v.blocks.some(b => b.key === key)) {
          v.blocks = [...v.blocks, { kind: "user", text: pending.text, key,
            eventId: key, attachments: pending.attachments, pending: true,
            ...(pending.queued ? { queued: true, queuedMode: pending.queuedMode ?? "queue" } : {}) }];
        }
      }
      // Queued sends reconcile against the authoritative log: withdrawal
      // deletes the echo (no fan-out row exists to announce it) and
      // delivery moves it — both land here via the state republish.
      v.blocks = reconcileQueuedSends(v.blocks, state.events, state.events[0]?.seq);
      // A summary entry can settle the indicator before the task poll returns.
      // Agent generation state is independent of compaction completion.
      if (compactingChat === cid) {
        if (v.blocks.some((b) => b.kind === "compaction" && !v.compactKeys.includes(b.key))) {
          compactingChat = null;
        }
      }
      return result(v);
    },

    applyThreadEvents(chatId, seq, events) {
      const v = viewOf(chatId);
      const fresh = events
        .filter((r) => r.seq > v.lastEventSeq)
        .sort((a, b) => a.seq - b.seq);
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
            v.blocks = [
              ...v.blocks.slice(0, -1),
              { ...last, text: last.text + (frame.content ?? "") },
            ];
          } else {
            v.blocks = [
              ...v.blocks,
              { kind: "text", text: frame.content ?? "", key: `unpersisted-${current}` },
            ];
          }
          break;
        }
        case "tool_started": {
          const tb = frame.call_id ? v.toolsByCall.get(frame.call_id) : undefined;
          if (tb) {
            tb.status = "running";
            tb.ts = tb.ts ?? nowIso();
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
            v.blocks.push({ kind: "tool", text: "", tool: fresh, key: `frame-${frame.call_id}` });
          }
          break;
        }
        case "tool_completed": {
          const tb = frame.call_id ? v.toolsByCall.get(frame.call_id) : undefined;
          if (tb) {
            tb.status = frame.is_error ? "error" : "done";
            tb.content = frame.content ?? tb.content;
            tb.endTs = nowIso();
          } else if (frame.call_id) {
            // A fast tool's completion frame can beat the anchor event's
            // notify fan-out: provision the finished row here — the durable
            // assistant_message adopts it (no duplicate).
            const fresh: ToolBlock = {
              callId: frame.call_id,
              name: frame.name ?? "tool",
              args: "",
              executor: frame.executor === "client" ? "client" : "server",
              status: frame.is_error ? "error" : "done",
              content: frame.content,
              ts: nowIso(),
              endTs: nowIso(),
            };
            v.toolsByCall.set(frame.call_id, fresh);
            v.blocks.push({ kind: "tool", text: "", tool: fresh, key: `frame-${frame.call_id}` });
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
      for (const v of views.values()) v.watermark = -1;
    },

    optimisticSend(pending) {
      const v = viewOf(pending.chatId ?? LOOSE);
      v.blocks = [
        ...v.blocks.filter(b => b.key !== pending.key),
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

    bindPending(chatId, key) {
      const pending = pendingOf(LOOSE).get(key);
      if (pending) {
        pendingOf(chatId).set(key, { ...pending, chatId });
        pendingOf(LOOSE).delete(key);
        const loose = viewOf(LOOSE);
        const bound = viewOf(chatId);
        bound.blocks = [...bound.blocks, ...loose.blocks.filter(b => b.key === key)];
        loose.blocks = loose.blocks.filter(b => b.key !== key);
      }
    },

    settleAttachment(key, pendingId, uploadedId) {
      const update = (attachments: PendingSend["attachments"]) => attachments?.map(a =>
        a.id === pendingId ? { ...a, ...(uploadedId ? { id: uploadedId, previewUrl: undefined } : {}) } : a);
      for (const sends of pendingByChat.values()) {
        const pending = sends.get(key);
        if (pending) sends.set(key, { ...pending, attachments: update(pending.attachments) });
      }
      for (const v of views.values()) {
        v.blocks = v.blocks.map(b => b.key === key && b.kind === "user"
          ? { ...b, attachments: update(b.attachments) } : b);
      }
      return result(viewOf(current));
    },

    appendError(text) {
      const v = viewOf(current);
      v.blocks = [...v.blocks, { kind: "error", text, key: liveKey() }];
      return result(v);
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
      v.blocks = [
        ...v.blocks.filter((b) => b.key !== key),
        { kind: "error", text: errorText, key: liveKey() },
      ];
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
      return result(viewOf(current));
    },
    finishCompacting(chatId) {
      if (compactingChat === chatId) compactingChat = null;
      return result(viewOf(current));
    },
  };
  return api;
}
