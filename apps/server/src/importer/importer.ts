// The re-runnable thread importer (spec decision 6): rebuilds the durable
// store from `thread_events` (the event log is the source of truth for
// history; pi-durable needs its own entries/tasks/documents for resume,
// compaction, steering, and subagents). Each run TRUNCATES + rebuilds the
// durable_* tables and the chat_conversations mapping — safe during
// development and at the cutover runbook's checkpoint (backup → run →
// verify); after the final cutover run the log freezes and the durable store
// is authoritative.
//
// Event → entry mapping (parity with build_model_history, restate.rs):
//   user_message      → pi.user entry (text; image attachments ride as
//                       ImageContent when their bytes load from object
//                       storage; audio has no pi user-content part — the
//                       text note covers it)
//   assistant_message → pi.assistant entry (blocks → reasoning/text/toolCall,
//                       usage reconstructed; interrupted → stopReason aborted)
//   tool_result       → pi.tool-result entry (text + stored image parts)
//   system_message    → guild.system log-only entry (excluded from context)
//   approval_request / approval_decision → guild.approval_* log-only entries
//   compaction        → pi.compaction entry with `head` recomputed over the
//                       active range: the summary + the keep_last tail kept
//                       verbatim, tool results pulled back to their
//                       assistant group (compaction_tail semantics)

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  CompactionEntry,
  Harness,
  ToolResultEntry,
  UserEntry,
  configure,
  createRegistry,
  type ConversationId,
  type EntryId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, JsonObject, Models, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { applyPostgresMigrations, PgPoolDatabase, PostgresDurableStorage } from "../storage/postgres/index.js";
import { SharedPoolDatabase, applyChatMappingMigration } from "../harness/runtime.js";
import type { PlatformPool } from "../platform/db.js";
import { ObjectStore } from "../platform/s3.js";
import { attachmentObjectKey } from "../platform/store/attachments.js";
import { normalizeThreadEvent, type ThreadEventRow } from "../platform/domain/thread-events.js";

export interface ImportCounts {
  chats: number;
  conversations: number;
  events: number;
  entries: number;
  /** Chats whose durable conversation was rebuilt from an EMPTY log. */
  emptyChats: number;
}

export interface ImporterLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ImporterOptions {
  /** Object storage (attachment bytes). When absent, image parts are not
   *  replayed into the durable user entries (the text note still renders). */
  objects?: ObjectStore;
  /** Whether the org's model route supports the image modality — gates the
   *  image parts exactly like the Rust per-turn derivation (approximated
   *  with the thread's last model, the one future turns resume with). */
  supportsImages?(orgId: string, model: string): Promise<boolean>;
}

/** One appended entry the compaction walkback tracks. */
interface LedgerLine {
  id: EntryId;
  /** Contributes a model message (user / assistant / tool result). */
  messageBearing: boolean;
  kind: "user" | "assistant" | "tool" | "other";
  toolCallId: string | null;
  /** Ledger index of the tool result's parent assistant line. */
  parent: number | null;
}

export async function importThreads(pool: PlatformPool, log: ImporterLogger, options: ImporterOptions = {}): Promise<ImportCounts> {
  const db = new PgPoolDatabase(pool);
  await applyPostgresMigrations(db);
  await applyChatMappingMigration(pool);

  // Rebuild: truncate the durable tables + the mapping (development and
  // cutover semantics — each run rebuilds from the event log).
  // Data tables only — durable_metadata/durable_schema are migration
  // infrastructure and must survive (applyPostgresMigrations tracks applied
  // versions there).
  for (const table of [
    "chat_conversations",
    "document_revisions",
    "documents",
    "submissions",
    "tasks",
    "entries",
    "conversations",
    "record_ids",
  ]) {
    await pool.query(`TRUNCATE TABLE ${table} CASCADE`);
  }

  // The caller owns the pool — the storage facade must not end it on close.
  const storage = await PostgresDurableStorage.open(new SharedPoolDatabase(pool));
  const registry = createRegistry();
  const harness = await Harness.open(storage, { models: createModels() as Models, registry }, BACKGROUND_CONTEXT);
  // No resume(): the importer writes history, it never schedules work.

  const counts: ImportCounts = { chats: 0, conversations: 0, events: 0, entries: 0, emptyChats: 0 };

  try {
    // Every chat of every org, in creation order (conversations need no
    // ordering among themselves; chats' events keep their own seq order).
    const chats = await pool.query<{ id: string; org_id: string; title: string | null }>(
      "SELECT id, org_id, title FROM chats ORDER BY created_at, id",
    );
    for (const chat of chats.rows) {
      counts.chats += 1;
      const events = await listEvents(pool, chat.id);
      counts.events += events.length;
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      counts.conversations += 1;
      if (events.length === 0) {
        counts.emptyChats += 1;
      } else {
        counts.entries += await appendHistory(harness, conversation.id, chat.org_id, events, pool, options);
      }
      await pool.query(
        "INSERT INTO chat_conversations (chat_id, conversation_id) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id",
        [chat.id, conversation.id],
      );
      if (counts.chats % 25 === 0) log.info(`imported ${counts.chats} chats…`);
    }
    log.info(
      `import complete: ${counts.chats} chats → ${counts.conversations} conversations, ${counts.events} events → ${counts.entries} entries (${counts.emptyChats} empty)`,
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT).catch(() => {});
    await storage.close(BACKGROUND_CONTEXT).catch(() => {});
  }
  return counts;
}

/** Appends one chat's history; returns the entry count. One commit per chat
 *  (the importer is offline; atomic per chat keeps a crash mid-run
 *  restartable with the same truncate+rebuild semantics). */
async function appendHistory(
  harness: Harness,
  conversationId: ConversationId,
  orgId: string,
  events: ThreadEventRow[],
  pool: PlatformPool,
  options: ImporterOptions,
): Promise<number> {
  const ledger: LedgerLine[] = [];
  let entryCount = 0;
  // Image-modality support for the thread's last model (the one future turns
  // resume with) — the Rust derivation gates per turn; the import fixes the
  // media the durable context replays.
  const latestModel = [...events].reverse().find((row) => row.event.type === "assistant_message");
  const imagesSupported =
    options.supportsImages !== undefined &&
    options.objects !== undefined &&
    latestModel !== undefined && latestModel.event.type === "assistant_message"
      ? await options.supportsImages(orgId, latestModel.event.model).catch(() => false)
      : false;
  const media =
    options.objects !== undefined && imagesSupported
      ? await loadChatMedia(pool, options.objects, orgId, events)
      : new Map<string, { mime: string; b64: string }>();
  await harness.commit(async (tx) => {
    // The conversation's agent model: the latest assistant event's model
    // (the model the thread was last run with — latest_assistant_model).
    if (latestModel && latestModel.event.type === "assistant_message") {
      await configure(tx, conversationId, { model: { provider: `guild:${orgId}`, modelId: latestModel.event.model } });
    }
    for (const row of events) {
      const line = await appendEventEntry(tx, conversationId, row, ledger, media);
      entryCount += 1;
      if (line !== null) ledger.push(line);
    }
  }, BACKGROUND_CONTEXT);
  return entryCount;
}

/** Image attachment bytes for a chat's user events (immutable object
 *  reads); missing uploads are tolerated, like the turn path. */
async function loadChatMedia(
  pool: PlatformPool,
  objects: ObjectStore,
  orgId: string,
  events: ThreadEventRow[],
): Promise<Map<string, { mime: string; b64: string }>> {
  const wanted = new Set<string>();
  for (const row of events) {
    if (row.event.type !== "user_message") continue;
    for (const chip of row.event.attachments) {
      if (chip.modality === "image") wanted.add(chip.id);
    }
  }
  const map = new Map<string, { mime: string; b64: string }>();
  if (wanted.size === 0) return map;
  const placeholders = [...wanted].map((_, i) => `$${i + 2}`).join(", ");
  const res = await pool.query<{ id: string; filename: string; content_type: string }>(
    `SELECT id, filename, content_type FROM attachments WHERE org_id = $1 AND id IN (${placeholders})`,
    [orgId, ...wanted],
  );
  for (const row of res.rows) {
    try {
      const bytes = await objects.get(attachmentObjectKey(orgId, row.id, row.filename));
      map.set(row.id, { mime: row.content_type, b64: bytes.toString("base64") });
    } catch {
      // missing upload — tolerated, like the turn path
    }
  }
  return map;
}

/** Maps one event to an entry; returns the ledger line for tracked entries
 *  (null otherwise). Compaction entries update the ledger's active range in
 *  place. */
async function appendEventEntry(
  tx: Tx,
  conversationId: ConversationId,
  row: ThreadEventRow,
  ledger: LedgerLine[],
  media: Map<string, { mime: string; b64: string }>,
): Promise<LedgerLine | null> {
  const ev = row.event;
  const timestamp = Date.parse(row.created_at);
  const ts = Number.isFinite(timestamp) ? timestamp : 0;
  switch (ev.type) {
    case "user_message": {
      const imageParts = [...media.entries()]
        .filter(([id]) => ev.attachments.some((chip) => chip.id === id && chip.modality === "image"))
        .map(([, m]) => ({ type: "image" as const, mimeType: m.mime, data: m.b64 }));
      const message: UserMessage =
        imageParts.length === 0
          ? { role: "user", content: ev.content, timestamp: ts }
          : {
              role: "user",
              content: [{ type: "text", text: ev.content }, ...imageParts],
              timestamp: ts,
            };
      const entry = await tx.appendEntry(UserEntry, conversationId, { model: [message] });
      return { id: entry.id, messageBearing: true, kind: "user", toolCallId: null, parent: null };
    }
    case "assistant_message": {
      const content: AssistantMessage["content"] = [];
      let reasoning = "";
      let text = "";
      let hasToolCalls = false;
      for (const block of ev.blocks) {
        if (block.type === "reasoning") reasoning += block.text;
        else if (block.type === "text") text += block.text;
        else if (block.type === "tool_call") {
          hasToolCalls = true;
          let args: JsonObject;
          try {
            const parsed: unknown = JSON.parse(block.arguments);
            args = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
          } catch {
            // Unparseable model arguments: the Rust model context carries the
            // raw string value; pi's ToolCall wants an object — the block is
            // preserved with an empty payload (rendering unaffected).
            args = {};
          }
          content.push({ type: "toolCall", id: block.id, name: block.name, arguments: args });
        }
      }
      if (reasoning !== "") content.unshift({ type: "thinking", thinking: reasoning });
      if (text !== "") {
        const index = content.findIndex((part) => part.type !== "thinking");
        content.splice(index < 0 ? content.length : index, 0, { type: "text", text });
      }
      const tokensIn = ev.usage.tokens_in ?? 0;
      const tokensOut = ev.usage.tokens_out ?? 0;
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "guild",
        model: ev.model,
        usage: {
          input: tokensIn,
          output: tokensOut,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: tokensIn + tokensOut,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: ev.usage.cost_usd ?? 0 },
        },
        stopReason: ev.interrupted === true ? "aborted" : hasToolCalls ? "toolUse" : "stop",
        timestamp: ts,
      };
      const entry = await tx.appendEntry(AssistantEntry, conversationId, { model: [message] });
      return { id: entry.id, messageBearing: true, kind: "assistant", toolCallId: null, parent: ledger.length };
    }
    case "tool_result": {
      const images = (ev.images ?? [])
        .map((dataUri) => {
          const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUri);
          return match ? { type: "image" as const, mimeType: match[1]!, data: match[2]! } : null;
        })
        .filter((part): part is { type: "image"; mimeType: string; data: string } => part !== null);
      const message: ToolResultMessage = {
        role: "toolResult",
        toolCallId: ev.call_id,
        toolName: ev.name,
        content: [{ type: "text", text: ev.content }, ...images],
        isError: ev.is_error,
        timestamp: ts,
      };
      const entry = await tx.appendEntry(ToolResultEntry, conversationId, { model: [message], data: { diagnostics: [] } });
      const parent = lastAssistantIndex(ledger);
      return { id: entry.id, messageBearing: true, kind: "tool", toolCallId: ev.call_id, parent };
    }
    case "system_message": {
      await tx.appendEntry(conversationId, { kind: "guild.system", data: { content: ev.content } });
      return null;
    }
    case "approval_request": {
      await tx.appendEntry(conversationId, {
        kind: "guild.approval_request",
        data: { call_id: ev.call_id, name: ev.name, arguments: ev.arguments },
      });
      return null;
    }
    case "approval_decision": {
      await tx.appendEntry(conversationId, {
        kind: "guild.approval_decision",
        data: { call_id: ev.call_id, approved: ev.approved, ...(ev.reason === undefined ? {} : { reason: ev.reason }), expired: ev.expired },
      });
      return null;
    }
    case "compaction": {
      // Active-range walkback (Rust §B): everything before the compaction is
      // replaced by the summary; the last `keep_last` message-bearing entries
      // of the ACTIVE range stay verbatim; tool results in that tail pull
      // their parent assistant back in (compaction_tail).
      const keep = ev.keep_last ?? 4;
      const active = ledger.filter((line) => line.messageBearing);
      let firstKept = 0;
      if (active.length > keep) {
        let keptCount = 0;
        for (let i = active.length - 1; i >= 0; i--) {
          keptCount += 1;
          firstKept = i;
          if (keptCount >= keep) break;
        }
        // Pull tool results back to their parent assistant group.
        for (let i = active.length - 1; i >= firstKept; i--) {
          const parent = active[i]!.parent;
          if (parent === null) continue;
          const parentActive = active.findIndex((line) => line.parent === parent);
          if (parentActive >= 0 && parentActive < firstKept) firstKept = parentActive;
        }
      }
      const firstKeptId = active.length > 0 ? active[firstKept]!.id : null;
      const message: UserMessage = {
        role: "user",
        content: `[Conversation summary so far]\n\n${ev.summary}`,
        timestamp: ts,
      };
      const entry = await tx.appendEntry(CompactionEntry, conversationId, {
        model: [message],
        ...(firstKeptId === null ? {} : { head: firstKeptId }),
        data: { reason: "manual" },
      });
      // The new active range starts at the compaction's head; later
      // compactions walk back only over what stays visible.
      if (firstKeptId !== null) {
        const cut = ledger.findIndex((line) => line.id === firstKeptId);
        ledger.length = cut < 0 ? ledger.length : cut;
      }
      return { id: entry.id, messageBearing: false, kind: "other", toolCallId: null, parent: null };
    }
    default:
      return null;
  }
}

function lastAssistantIndex(ledger: LedgerLine[]): number | null {
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i]!.kind === "assistant") return i;
  }
  return null;
}

/** The chat's thread event rows in seq order (no org join — the importer
 *  runs offline over the trusted database). */
async function listEvents(pool: PlatformPool, chatId: string): Promise<ThreadEventRow[]> {
  const res = await pool.query<{ id: string; chat_id: string; seq: string; payload: unknown; created_at: string }>(
    `SELECT id, chat_id, seq, payload,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
     FROM thread_events WHERE chat_id = $1 ORDER BY seq`,
    [chatId],
  );
  const rows: ThreadEventRow[] = [];
  for (const r of res.rows) {
    const event = normalizeThreadEvent(r.payload as Record<string, unknown>);
    if (!event) continue; // lenient: unknown future types drop (Rust semantics)
    rows.push({ id: r.id, chat_id: r.chat_id, seq: Number(r.seq), event, created_at: r.created_at });
  }
  return rows;
}
