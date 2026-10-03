// M3 importer tests: the re-runnable thread importer against REAL captured
// thread_events (live :18080 database, anonymized but structurally faithful
// — uuid shapes, seq monotonicity, timestamps, payload field order; text
// truncated, names/emails/ids redacted). Fixture: 4 chats / 314 events
// covering every event type (assistant 122, tool_result 149, system 16,
// user 16, approvals 5+5, compaction 1) plus one empty chat.

import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PostgresDurableStorage } from "../storage/postgres/index.js";
import { importThreads } from "../importer/importer.js";
import { SharedPoolDatabase } from "../harness/runtime.js";
import { MIGRATIONS_DIR, TEST_ADMIN_URL } from "./platform/harness.js";

const FIXTURE_PATH = new URL("./fixtures/m3-threads.json", import.meta.url);

interface FixtureThreadEvent {
  id: string;
  chat_id: string;
  seq: number;
  payload: Record<string, unknown>;
  created_at: string;
}
interface Fixture {
  orgs: { id: string; name: string; created_at: string }[];
  users: { id: string; org_id: string; email: string; display_name: string; created_at: string }[];
  chats: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  thread_events: FixtureThreadEvent[];
}

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

let adminPool: pg.Pool;
let pool: pg.Pool;
let databaseUrl: string;
let cleanupDb: () => Promise<void>;

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
  const name = `guild_m3_import_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(TEST_ADMIN_URL);
  url.pathname = `/${name}`;
  databaseUrl = url.toString();
  pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const migrationPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const { readdirSync } = await import("node:fs");
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    await migrationPool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  await migrationPool.end();
  cleanupDb = async () => {
    await pool.end();
    const dropper = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
    try {
      // Same WITH (FORCE) transient as the shared harness cleanup — retry.
      for (let attempt = 1; ; attempt++) {
        try {
          await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          break;
        } catch (error) {
          if (attempt >= 4) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("terminate process")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
    } finally {
      await dropper.end();
    }
    await adminPool.end();
  };
});

afterAll(async () => {
  await cleanupDb();
});

async function seedFixture(): Promise<void> {
  for (const org of FIXTURE.orgs) {
    await pool.query("INSERT INTO orgs (id, name, created_at) VALUES ($1, $2, $3)", [org.id, org.name, org.created_at]);
  }
  for (const user of FIXTURE.users) {
    await pool.query("INSERT INTO users (id, org_id, email, password_hash, role, display_name, created_at) VALUES ($1, $2, $3, $4, 'admin', $5, $6)", [
      user.id,
      user.org_id,
      user.email,
      "x",
      user.display_name,
      user.created_at,
    ]);
  }
  for (const chat of FIXTURE.chats) {
    await pool.query(
      "INSERT INTO chats (id, org_id, user_id, title, created_at, machine_id, machine_label, generating, approval, project_id, archived_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        chat.id,
        chat.org_id,
        chat.user_id,
        chat.title,
        chat.created_at,
        chat.machine_id,
        chat.machine_label,
        chat.generating,
        chat.approval,
        chat.project_id,
        chat.archived ? new Date() : null,
      ],
    );
  }
  for (const e of FIXTURE.thread_events) {
    await pool.query("INSERT INTO thread_events (id, chat_id, seq, type, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      e.id,
      e.chat_id,
      e.seq,
      e.payload.type,
      JSON.stringify(e.payload),
      e.created_at,
    ]);
  }
}

const logger = { info: () => {}, warn: (m: string) => console.warn(m) };

describe("thread importer", () => {
  it("rebuilds durable_* from real captured thread_events", async () => {
    await seedFixture();
    const counts = await importThreads(pool as never, logger, {});
    expect(counts.chats).toBe(4);
    expect(counts.conversations).toBe(4);
    expect(counts.events).toBe(314);
    // Every event maps to exactly one durable entry (message-bearing or
    // log-only) with this fixture.
    expect(counts.entries).toBe(314);
    expect(counts.emptyChats).toBe(1);

    // Mapping table: one row per chat, valid conversation ids.
    const mapping = await pool.query<{ chat_id: string; conversation_id: string }>(
      "SELECT chat_id, conversation_id::text FROM chat_conversations ORDER BY conversation_id::text",
    );
    expect(mapping.rows).toHaveLength(4);
    const chatIds = new Set(FIXTURE.chats.map((c) => c.id));
    for (const row of mapping.rows) expect(chatIds.has(row.chat_id)).toBe(true);

    // Entry kinds across the rebuild.
    const kinds = await pool.query<{ kind: string; n: string }>(
      "SELECT (record::jsonb->>'kind') kind, count(*) n FROM entries GROUP BY kind ORDER BY n DESC",
    );
    const byKind = Object.fromEntries(kinds.rows.map((r) => [r.kind, Number(r.n)]));
    expect(byKind).toMatchObject({
      "pi.assistant": 122,
      "pi.tool-result": 149,
      "pi.user": 16,
      "guild.system": 16,
      "guild.approval_request": 5,
      "guild.approval_decision": 5,
      "pi.compaction": 1,
    });

    // Assistant entries parse to the Rust-equivalent model shape: provider
    // guild:<org>, reconstructed usage, toolUse stop when tool calls follow.
    const assistants = await pool.query<{ record: { model?: unknown[] } }>(
      "SELECT record::jsonb record FROM entries WHERE record::jsonb->>'kind' = 'pi.assistant' ORDER BY id DESC LIMIT 50",
    );
    const withTools = assistants.rows
      .map((r) => (r.record.model as Record<string, unknown>[])[0] ?? {})
      .filter((m) => Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === "toolCall"));
    expect(withTools.length).toBeGreaterThan(0);
    for (const message of withTools) {
      expect(message.stopReason).toBe("toolUse");
      expect(message.provider).toBe("guild");
      expect(message.api).toBe("openai-completions");
      const usage = message.usage as { totalTokens: number; cost: { total: number } };
      expect(usage.totalTokens).toBeGreaterThan(0);
      expect(usage.cost.total).toBeGreaterThanOrEqual(0);
    }

    // Tool-result entries carry toolCallId + toolName + diagnostics data.
    const toolResults = await pool.query<{ record: { model?: Record<string, unknown>[]; data?: unknown } }>(
      "SELECT record::jsonb record FROM entries WHERE record::jsonb->>'kind' = 'pi.tool-result' ORDER BY id DESC LIMIT 20",
    );
    expect(toolResults.rows.length).toBeGreaterThan(0);
    for (const row of toolResults.rows) {
      const message = row.record.model?.[0];
      expect(typeof message?.toolCallId).toBe("string");
      expect(typeof message?.toolName).toBe("string");
      expect(row.record.data).toMatchObject({ diagnostics: [] });
    }
  });

  it("recomputes the compaction head over the active range (compaction_tail parity)", async () => {
    const compaction = FIXTURE.thread_events.find((e) => e.payload.type === "compaction");
    expect(compaction).toBeDefined();
    const keep = (compaction!.payload.keep_last as number) ?? 4;

    // Expected first-kept event: walk back over the chat's message-bearing
    // events (user/assistant/tool_result), then pull tool results whose
    // parent assistant sits before the window back into it.
    // Walkback runs at compaction time: only events BEFORE it are active.
    const chatEvents = FIXTURE.thread_events
      .filter((e) => e.chat_id === compaction!.chat_id && e.seq < compaction!.seq)
      .sort((a, b) => a.seq - b.seq);
    const active = chatEvents.filter((e) => ["user_message", "assistant_message", "tool_result"].includes(e.payload.type as string));
    let firstKept = 0;
    if (active.length > keep) {
      let kept = 0;
      for (let i = active.length - 1; i >= 0; i--) {
        kept += 1;
        firstKept = i;
        if (kept >= keep) break;
      }
      for (let i = active.length - 1; i >= firstKept; i--) {
        if (active[i]!.payload.type !== "tool_result") continue;
        const callId = active[i]!.payload.call_id as string;
        const parentIdx = active.findIndex(
          (e) => e.payload.type === "assistant_message" && (e.payload.blocks as { type: string; id?: string }[]).some((b) => b.type === "tool_call" && b.id === callId),
        );
        if (parentIdx >= 0 && parentIdx < firstKept) firstKept = parentIdx;
      }
    }
    const expected = active[firstKept]!;

    const compactionEntry = await pool.query<{ record: { head?: number; model?: { message?: { content: string } }[] } }>(
      "SELECT record::jsonb record FROM entries WHERE record::jsonb->>'kind' = 'pi.compaction'",
    );
    expect(compactionEntry.rows).toHaveLength(1);
    const record = compactionEntry.rows[0]!.record;
    expect(typeof record.head).toBe("number");
    const summary = (record.model?.[0] as { content?: string } | undefined)?.content ?? "";
    expect(summary.startsWith("[Conversation summary so far]\n\n")).toBe(true);

    // The entry at `head` carries the expected first-kept event's content.
    const headRow = await pool.query<{ record: { model?: { message?: Record<string, unknown> }[] } }>(
      "SELECT record::jsonb record FROM entries WHERE id = $1",
      [record.head],
    );
    expect(headRow.rows).toHaveLength(1);
    const headMessage = headRow.rows[0]!.record.model?.[0];
    const expectedMessage: unknown =
      expected.payload.type === "user_message"
        ? expected.payload.content
        : expected.payload.type === "tool_result"
          ? (expected.payload as { content: string }).content
          : (expected.payload as { blocks: { type: string; text?: string }[] }).blocks
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("");
    expect(JSON.stringify(headMessage)).toContain(String(expectedMessage).slice(0, 60));

    // Message-bearing entries at/after the head: the tail (4) plus pulled
    // tool-result parents, nothing before the head is message-bearing by
    // construction of the walkback.
    const afterHead = await pool.query<{ n: string }>(
      "SELECT count(*) n FROM entries WHERE conversation_id = (SELECT conversation_id FROM entries WHERE id = $1) AND id >= $1 AND record::jsonb->>'kind' IN ('pi.user','pi.assistant','pi.tool-result')",
      [record.head],
    );
    expect(Number(afterHead.rows[0]!.n)).toBeGreaterThanOrEqual(keep);
  });

  it("is re-runnable: a second run produces identical counts (truncate + rebuild)", async () => {
    const first = await importThreads(pool as never, logger, {});
    const conversationsBefore = await pool.query("SELECT count(*) n FROM conversations");
    const entriesBefore = await pool.query("SELECT count(*) n FROM entries");

    const second = await importThreads(pool as never, logger, {});
    const conversationsAfter = await pool.query("SELECT count(*) n FROM conversations");
    const entriesAfter = await pool.query("SELECT count(*) n FROM entries");

    expect(second.chats).toBe(first.chats);
    expect(second.conversations).toBe(first.conversations);
    expect(second.events).toBe(first.events);
    expect(second.entries).toBe(first.entries);
    expect(Number(entriesAfter.rows[0]!.n)).toBe(Number(entriesBefore.rows[0]!.n));
    expect(Number(conversationsAfter.rows[0]!.n)).toBe(Number(conversationsBefore.rows[0]!.n));

    // The mapping still resolves every chat.
    const mapping = await pool.query("SELECT count(*) n FROM chat_conversations");
    expect(Number(mapping.rows[0]!.n)).toBe(4);
  });

  it("entries read back through pi-durable storage (typed, with heads)", async () => {
    const db = new SharedPoolDatabase(pool);
    const storage = await PostgresDurableStorage.open(db);
    try {
      const page = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
      expect(page.items.length).toBe(4);
      const target = page.items[0]!;
      const entries = await storage.scanEntries({ conversationId: target.id }, 1000, undefined, BACKGROUND_CONTEXT);
      expect(entries.items.length).toBeGreaterThan(0);
      for (const entry of entries.items) {
        expect(typeof entry.id).toBe("number");
        expect(entry.kind).toMatch(/^(pi\.|guild\.)/);
      }
      const compaction = entries.items.find((e: { kind?: string }) => e.kind === "pi.compaction");
      if (compaction !== undefined) expect((compaction as { head?: number }).head).not.toBeUndefined();
    } finally {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
    }
  });
});
