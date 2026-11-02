// Skill-read sink tests — a fake ClickhouseClient capturing insert/query
// calls (no live ClickHouse; the usage sink has no dedicated unit tests
// either, so this mirrors the minimal-stub approach).

import { describe, expect, it, vi } from "vitest";
import type { ClickhouseClient } from "../../platform/clickhouse.js";
import { SkillReadSink, type SkillReadEvent } from "../../platform/skill-reads.js";
import type { PlatformPool } from "../../platform/db.js";

interface FakeClient {
  insert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  ensureSkillReadsTable: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    insert: vi.fn(async () => {}),
    query: vi.fn(async () => []),
    execute: vi.fn(async () => {}),
    ensureSkillReadsTable: vi.fn(async () => {}),
    ...overrides,
  };
}

function sink(client: FakeClient): SkillReadSink {
  return new SkillReadSink(client as unknown as ClickhouseClient);
}

function event(overrides: Partial<SkillReadEvent> = {}): SkillReadEvent {
  return {
    ts: new Date("2026-10-13T12:34:56Z"),
    org_id: "018f0000-0000-7000-8000-000000000001",
    user_id: "018f0000-0000-7000-8000-000000000002",
    team_id: "018f0000-0000-7000-8000-000000000003",
    slug: "python-style",
    bundle_sha256: "abc123",
    chat_id: "018f0000-0000-7000-8000-000000000004",
    ...overrides,
  };
}

describe("SkillReadSink.record", () => {
  it("inserts one row into skill_reads with the event values", async () => {
    const client = fakeClient();
    const s = sink(client);
    await s.record(event());

    expect(client.insert).toHaveBeenCalledTimes(1);
    const [table, rows] = client.insert.mock.calls[0] as [string, Record<string, unknown>[]];
    expect(table).toBe("skill_reads");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      ts: "2026-10-13 12:34:56",
      org_id: "018f0000-0000-7000-8000-000000000001",
      user_id: "018f0000-0000-7000-8000-000000000002",
      team_id: "018f0000-0000-7000-8000-000000000003",
      slug: "python-style",
      bundle_sha256: "abc123",
      chat_id: "018f0000-0000-7000-8000-000000000004",
    });
  });

  it("maps null team_id and chat_id to empty strings (String columns)", async () => {
    const client = fakeClient();
    const s = sink(client);
    await s.record(event({ team_id: null, chat_id: null }));

    const rows = client.insert.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0]["team_id"]).toBe("");
    expect(rows[0]["chat_id"]).toBe("");
  });

  it("fills a missing team with the user's earliest team from the pool", async () => {
    const client = fakeClient();
    const s = sink(client);
    const pool = {
      query: vi.fn(async () => ({ rows: [{ id: "team-earliest" }] })),
    } as unknown as PlatformPool;
    s.attachPool(pool);
    await s.record(event({ team_id: null }));

    expect(pool.query).toHaveBeenCalledTimes(1);
    const rows = client.insert.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0]["team_id"]).toBe("team-earliest");
  });

  it("leaves team as empty string when the pool has no membership and no pool is attached", async () => {
    const client = fakeClient();
    const s = sink(client);
    await s.record(event({ team_id: null }));

    const rows = client.insert.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0]["team_id"]).toBe("");
  });

  it("swallows insert failures (logged, resolved)", async () => {
    const client = fakeClient({
      insert: vi.fn(async () => {
        throw new Error("clickhouse down");
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(sink(client).record(event())).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SkillReadSink.record + ensureOnce", () => {
  it("record awaits ensureOnce so the table exists before the first insert", async () => {
    const client = fakeClient();
    const s = sink(client);
    await s.record(event());

    expect(client.ensureSkillReadsTable).toHaveBeenCalledTimes(1);
    expect(client.insert).toHaveBeenCalledTimes(1);
  });

  it("record drops the insert (logged, no throw) when the DDL fails", async () => {
    const client = fakeClient({
      ensureSkillReadsTable: vi.fn(async () => {
        throw new Error("clickhouse down");
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(sink(client).record(event())).resolves.toBeUndefined();
      expect(client.insert).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SkillReadSink.ensureOnce", () => {
  it("runs the skill_reads DDL exactly once", async () => {
    const client = fakeClient();
    const s = sink(client);
    await Promise.all([s.ensureOnce(), s.ensureOnce(), s.ensureOnce()]);

    expect(client.ensureSkillReadsTable).toHaveBeenCalledTimes(1);
    expect(client.execute).not.toHaveBeenCalled();
  });
});

describe("readsBySlug", () => {
  it("queries the count for (org, slug, window) and returns the number", async () => {
    const client = fakeClient({ query: vi.fn(async () => [{ reads: 7 }]) });
    const value = await sink(client).readsBySlug("018f0000-0000-7000-8000-000000000001", "python-style", 30);

    expect(value).toBe(7);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("FROM skill_reads");
    expect(sql).toContain("count()");
    expect(params).toEqual(["018f0000-0000-7000-8000-000000000001", "python-style", expect.any(Number)]);
  });

  it("degrades to 0 when the query throws", async () => {
    const client = fakeClient({
      query: vi.fn(async () => {
        throw new Error("UNKNOWN_TABLE");
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(sink(client).readsBySlug("org", "slug", 30)).resolves.toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("readsByDay", () => {
  it("returns per-day read counts ordered by day", async () => {
    const client = fakeClient({
      query: vi.fn(async () => [
        { day: "2026-10-12", reads: 3 },
        { day: "2026-10-13", reads: 9 },
      ]),
    });
    const rows = await sink(client).readsByDay("org", "python-style", 14);

    expect(rows).toEqual([
      { day: "2026-10-12", reads: 3 },
      { day: "2026-10-13", reads: 9 },
    ]);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql] = client.query.mock.calls[0] as [string];
    expect(sql).toContain("toDate(ts) AS day");
    expect(sql).toContain("GROUP BY day");
    expect(sql).toContain("ORDER BY day");
  });

  it("degrades to an empty array when the query throws", async () => {
    const client = fakeClient({
      query: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(sink(client).readsByDay("org", "slug", 14)).resolves.toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
