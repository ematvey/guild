// jsonbText makes JSON text well-formed before Postgres parses it. A lone
// UTF-16 surrogate is legal JSON text, but jsonb rejects its escape at parse
// time.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestDatabase, type TestDatabase } from "./support/postgres.js";
import { jsonbText } from "../platform/domain/text.js";

describe("jsonbText", () => {
  it("replaces a lone surrogate with U+FFFD", () => {
    const out = jsonbText({ text: "a\ud83db" });
    expect(out).toContain("\ufffd");
    expect(out).not.toContain("\\ud83d");
  });

  it("leaves well-formed text byte-identical", () => {
    const value = { text: "a😀b" };
    expect(jsonbText(value)).toBe(JSON.stringify(value));
  });

  it("replaces U+0000 with U+FFFD", () => {
    expect(jsonbText({ text: "a\u0000b" })).toContain("\ufffd");
  });

  it("replaces U+0000 in a property name", () => {
    const out = jsonbText({ "a\u0000b": 1 });
    expect(out).toContain("a\uFFFDb");
    expect(out).not.toContain("a\u0000b");
  });
});

describe("jsonbText against Postgres", () => {
  let database: TestDatabase;
  let db: pg.Pool;

  beforeAll(async () => {
    database = await createTestDatabase("guild_jsonb_test_", { migrate: false, poolMax: 1 });
    db = database.pool;
    await db.query("CREATE TABLE probe (v jsonb NOT NULL)");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("rejects the raw JSON.stringify escape and accepts jsonbText", async () => {
    await expect(db.query("SELECT $1::jsonb", [JSON.stringify({ text: "a\ud83db" })])).rejects.toMatchObject({
      code: "22P02",
    });

    const text = jsonbText({ text: "a\ud83db" });
    await db.query("INSERT INTO probe (v) VALUES ($1::jsonb)", [text]);
    const back = await db.query<{ text: string }>("SELECT v->>'text' AS text FROM probe");
    expect(back.rows[0]!.text).toBe("a\ufffdb");
  });

  it("accepts a property name that held U+0000 only after jsonbText", async () => {
    await expect(db.query("SELECT $1::jsonb", [JSON.stringify({ "a\u0000b": 1 })])).rejects.toThrow();

    await db.query("INSERT INTO probe (v) VALUES ($1::jsonb)", [jsonbText({ "a\u0000b": 1 })]);
    const back = await db.query<{ v: Record<string, number> }>("SELECT v FROM probe WHERE v ? 'a\uFFFDb' LIMIT 1");
    expect(Object.keys(back.rows[0]!.v)).toEqual(["a\uFFFDb"]);
  });
});
