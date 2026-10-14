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
  ThreadEventRow,
  ThreadState,
} from "../transport";

// ---------- block shapes ----------

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
  /// kind === "user": context attachment chips (metadata only; images may
  /// carry a local preview URL for optimistic rendering).
  attachments?: (MessageAttachmentMeta & { previewUrl?: string })[];
  /// An optimistic user command not yet present in the durable history.
  pending?: boolean;
  /// kind === "reasoning": the accumulated thinking text.
  reasoningText?: string;
  /// kind === "text": the turn was stopped mid-stream; the text is the
  /// delivered prefix.
  interrupted?: boolean;
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
}

// ---------- derivation (event log → blocks) ----------

let liveKeyCounter = 0;
/// Key for blocks the stream builds (no source event seq to derive from).
function liveKey(): string {
  return `live-${++liveKeyCounter}`;
}

/// Tools the desktop executor runs locally (mirrors protocol `client_tool_specs`).
const CLIENT_TOOL_NAMES = [
  "read_file",
  "execute",
  "edit_file",
  "write_file",
];

interface DerivedThread {
  blocks: Block[];
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
            blocks.push({ kind: "reasoning", text: "", reasoningText: b.text, key: seqKey(inEvent++) });
          } else if (b.type === "text") {
            blocks.push({ kind: "text", text: b.text, key: seqKey(inEvent++) });
          } else {
            const tb: ToolBlock = {
              callId: b.id,
              name: b.name,
              args: b.arguments,
              executor: CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server",
              status: "done", // filled by the matching tool_result below
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
        } else {
          // Orphan result (call block missing): render it anyway rather than drop it.
          blocks.push({
            kind: "tool",
            text: "",
            tool: {
              callId: ev.call_id,
              name: ev.name || "tool",
              args: "",
              executor: "server",
              status: ev.is_error ? "error" : "done",
              content: ev.content,
              meta,
              kind,
            },
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
    }
  }
  // Resolved approvals are decisions, not conversation content: a card whose
  // decision event arrived is dropped, so history renders only approvals
  // still waiting for an answer. Expired cards stay: no tool result tells
  // their story — the card itself is the record that the call never ran.
  return {
    blocks: blocks.filter(
      (b) =>
        !(
          b.kind === "approval" &&
          b.approval &&
          (b.approval.status === "approved" || b.approval.status === "denied")
        ),
    ),
    toolsByCall,
    approvalsByCall,
  };
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
    { kind: "reasoning", text: "", reasoningText: content, key: seedKey ?? liveKey() },
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
      attachments: pending.attachments,
      pending: true,
    },
  ];
}

// ---------- the reducer ----------

export interface ApplyResult {
  blocks: Block[];
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
}

/// One chat's visible-thread state. `watermark` is the last applied
/// ThreadState seq (-1 = nothing yet: the next state derives the full log);
/// `lastEventSeq` is the last applied event row's seq — a state can advance
/// the log watermark without carrying new events, so event application keys
/// off this, not the watermark.
interface ChatView {
  blocks: Block[];
  watermark: number;
  lastEventSeq: number;
  toolsByCall: Map<string, ToolBlock>;
  approvalsByCall: Map<string, ApprovalBlock>;
  /// Compaction block keys present when /compact was sent: a sync adding a
  /// new one is the success signal.
  compactKeys: string[];
  /// The server's generating flag was seen while compacting: busy→false
  /// afterwards without a compaction event means the compaction appended
  /// nothing to the log.
  compactBusySeen: boolean;
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
  /** The send's HTTP request failed: the optimistic block goes, an error
   * block takes its place, and the pending marker is released. */
  failSend(chatId: string | null, key: string, errorText: string): ApplyResult;
  /** Arms (chatId) or disarms (null) the manual-compaction line. Arming
   * snapshots the compaction keys present now; applyState reconciles. */
  setCompacting(chatId: string | null): ApplyResult;
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
    watermark: -1,
    lastEventSeq: -1,
    toolsByCall: new Map(),
    approvalsByCall: new Map(),
    compactKeys: [],
    compactBusySeen: false,
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
    stale,
    compacting: compactingChat !== null && current !== LOOSE && compactingChat === current,
    restored,
  });

  function applyEvent(v: ChatView, row: ThreadEventRow): void {
    const ev = row.event;
    const seqKey = (n: number) => `${row.seq}:${n}`;
    switch (ev.type) {
      case "user_message": {
        const at = ev.content.indexOf("\n\n[Attachment: ");
        const inv = ev.content.indexOf("\n\n---\nInvoked skills");
        const cut = [at, inv].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
        v.blocks.push({
          kind: "user",
          text: cut >= 0 ? ev.content.slice(0, cut) : ev.content,
          attachments: ev.attachments,
          key: seqKey(0),
        });
        break;
      }
      case "system_message":
        break; // server-owned prompt, log-only
      case "assistant_message": {
        const start = v.blocks.length;
        for (const b of ev.blocks) {
          if (b.type === "reasoning") {
            v.blocks.push({ kind: "reasoning", text: "", reasoningText: b.text, key: seqKey(v.blocks.length - start) });
          } else if (b.type === "text") {
            v.blocks.push({ kind: "text", text: b.text, key: seqKey(v.blocks.length - start) });
          } else {
            // A live tool_started frame may have provisioned this row before
            // the carrying message fanned out: adopt it instead of pushing a
            // duplicate block.
            const existing = v.toolsByCall.get(b.id);
            if (existing) {
              existing.name = b.name;
              existing.args = b.arguments;
              existing.executor = CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server";
            } else {
              const tb: ToolBlock = {
                callId: b.id,
                name: b.name,
                args: b.arguments,
                executor: CLIENT_TOOL_NAMES.includes(b.name) ? "client" : "server",
                status: "done",
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
        } else {
          v.blocks.push({
            kind: "tool",
            text: "",
            tool: {
              callId: ev.call_id,
              name: ev.name || "tool",
              args: "",
              executor: "server",
              status: ev.is_error ? "error" : "done",
              content: ev.content,
              meta,
              kind,
            },
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
    }
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
      if (v.watermark < 0) {
        const d = deriveThread(state.events);
        v.blocks = d.blocks;
        v.toolsByCall = d.toolsByCall;
        v.approvalsByCall = d.approvalsByCall;
        v.lastEventSeq = state.events.reduce((max, r) => Math.max(max, r.seq), -1);
      } else {
        const fresh = state.events
          .filter((r) => r.seq > v.lastEventSeq)
          .sort((a, b) => a.seq - b.seq);
        for (const row of fresh) {
          applyEvent(v, row);
          v.lastEventSeq = Math.max(v.lastEventSeq, row.seq);
        }
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
      let blocks = v.blocks.filter(
        (b) => !b.key.startsWith("unpersisted-") && !b.key.startsWith("live-"),
      );
      if (state.thinking)
        blocks = upsertThinking(blocks, state.thinking, true, `live-thinking-${cid}`);
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
            attachments: pending.attachments, pending: true }];
        }
      }
      // Pending /compact reconciliation: a newly appeared compaction event
      // is the success signal; the server's busy flag dropping back to false
      // without one means the compaction failed (nothing was appended).
      if (compactingChat === cid) {
        if (v.blocks.some((b) => b.kind === "compaction" && !v.compactKeys.includes(b.key))) {
          compactingChat = null;
        } else if (state.generating) {
          v.compactBusySeen = true;
        } else if (v.compactBusySeen) {
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
      v.watermark = Math.max(v.watermark, seq);
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
          attachments: pending.attachments,
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
        v.compactBusySeen = false;
        compactingChat = chatId;
      }
      return result(viewOf(current));
    },
  };
  return api;
}
