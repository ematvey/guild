// Minimal ClickHouse HTTP-interface client over global fetch — the usage
// sink and the usage/quota queries. Each `?` in the SQL is replaced inline
// with the escaped bind literal (strings in single quotes, numbers raw).

import type { Config } from "../config.js";

export type BindValue = string | number;

export interface ClickhouseOptions {
  url: string;
  database: string;
  user: string;
  password: string;
}

/** The client over the configured ClickHouse (GUILD_CLICKHOUSE_*). */
export function clickhouseFromConfig(
  config: Pick<Config, "clickhouseUrl" | "clickhouseDatabase" | "clickhouseUser" | "clickhousePassword">,
): ClickhouseClient {
  return new ClickhouseClient({
    url: config.clickhouseUrl,
    database: config.clickhouseDatabase,
    user: config.clickhouseUser,
    password: config.clickhousePassword,
  });
}

export class ClickhouseClient {
  constructor(readonly opts: ClickhouseOptions) {}

  private endpoint(): URL {
    const url = new URL(this.opts.url);
    url.searchParams.set("database", this.opts.database);
    // 64-bit integers come back quoted by default — keep JSON output
    // numeric.
    url.searchParams.set("output_format_json_quote_64bit_integers", "0");
    if (this.opts.user !== "") {
      url.searchParams.set("user", this.opts.user);
      url.searchParams.set("password", this.opts.password);
    }
    return url;
  }

  /** Runs a statement with bound parameters; SELECTs return decoded rows. */
  async query(sql: string, params: BindValue[] = []): Promise<Record<string, unknown>[]> {
    const url = this.endpoint();
    const res = await fetch(url, {
      method: "POST",
      body: `${bindParams(sql, params)} FORMAT JSON`,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    const text = await res.text();
    if (!res.ok) throw new ClickhouseError(text);
    const parsed = JSON.parse(text) as { data?: Record<string, unknown>[] };
    return parsed.data ?? [];
  }

  /** Runs a statement without reading rows (DDL, inserts with data). */
  async execute(body: string, params: BindValue[] = []): Promise<void> {
    const url = this.endpoint();
    const res = await fetch(url, {
      method: "POST",
      body: bindParams(body, params),
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    const text = await res.text();
    if (!res.ok) throw new ClickhouseError(text);
  }

  /** Inserts rows as JSONEachRow. */
  async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    await this.execute(`INSERT INTO ${table} FORMAT JSONEachRow\n${body}`);
  }

  /** Ensures the usage_events table exists. */
  async ensureUsageTable(): Promise<void> {
    await this.execute(
      "CREATE TABLE IF NOT EXISTS usage_events (" +
        "ts DateTime, org_id UUID, user_id UUID, team_id Nullable(UUID), " +
        "session_id UUID, model String, provider String, " +
        "tokens_in UInt32, tokens_out UInt32, cost_usd Float64, request_id UUID" +
        ") ENGINE = MergeTree ORDER BY (org_id, ts)",
    );
  }

  /** Ensures the skill_reads table exists (org-wide skills; the DDL is
   *  specified in the skills design — String columns, team/chat ids empty
   *  when absent). */
  async ensureSkillReadsTable(): Promise<void> {
    await this.execute(
      "CREATE TABLE IF NOT EXISTS skill_reads (" +
        "ts DateTime64(3), org_id String, user_id String, team_id String, " +
        "slug String, bundle_sha256 String, chat_id String" +
        ") ENGINE = MergeTree ORDER BY (org_id, slug, ts)",
    );
  }
}

export class ClickhouseError extends Error {
  constructor(readonly body: string) {
    super(body.split("\n").slice(0, 2).join(" "));
  }

  /** The table has not been created yet — the queries degrade to empty. */
  get unknownTable(): boolean {
    return this.body.includes("UNKNOWN_TABLE");
  }
}



function bindParams(sql: string, params: BindValue[]): string {
  // No binds: the text goes out verbatim (insert bodies carry arbitrary
  // content that may contain '?').
  if (params.length === 0) return sql;
  let out = "";
  let rest = sql;
  let i = 0;
  for (;;) {
    const idx = rest.indexOf("?");
    if (idx === -1) {
      out += rest;
      break;
    }
    const value = params[i];
    if (value === undefined) throw new Error(`query binds ${i + 1} parameters but more '?' remain: ${sql.slice(0, 120)}`);
    out += rest.slice(0, idx);
    out += typeof value === "string" ? escapedString(value) : String(value);
    rest = rest.slice(idx + 1);
    i += 1;
  }
  return out;
}

/** clickhouse crate escape.rs: backslash-escapes \\, ', `, tab, newline. */
function escapedString(src: string): string {
  const escaped = src.replace(/[\\'`\t\n]/g, (c) => `\\${c}`);
  return `'${escaped}'`;
}

/** ClickHouse DateTime64(3) rendering (millisecond precision, UTC). */
export function clickhouseDateTime64(date: Date): string {
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${clickhouseDateTime(date)}.${ms}`;
}

/** ClickHouse DateTime rendering (second precision, UTC). */
export function clickhouseDateTime(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}` +
    `-${String(date.getUTCDate()).padStart(2, "0")}` +
    ` ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}` +
    `:${String(date.getUTCSeconds()).padStart(2, "0")}`
  );
}
