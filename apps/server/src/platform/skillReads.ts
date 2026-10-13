// Skill-read sink and read analytics — ClickHouse. Mirrors the usage sink:
// ensure-once DDL, defensive catch-and-log on every write and read so an
// unreachable ClickHouse never breaks a turn.

import { clickhouseDateTime, ClickhouseClient } from "./clickhouse.js";
import { errorText } from "./usage.js";
import type { PlatformPool } from "./db.js";

export interface SkillReadEvent {
  ts: Date;
  org_id: string;
  user_id: string;
  team_id: string | null;
  slug: string;
  bundle_sha256: string;
  chat_id: string | null;
}

export class SkillReadSink {
  private pool: PlatformPool | null = null;
  private ready: Promise<void> | null = null;

  constructor(readonly client: ClickhouseClient) {}

  attachPool(pool: PlatformPool): void {
    this.pool = pool;
  }

  /** The table-creation DDL; runs once per sink. */
  ensureOnce(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.client.ensureSkillReadsTable();
    }
    return this.ready;
  }

  /** Records one skill read; team attribution fills the user's earliest
   *  team (same lookup as UsageSink.record). The skill_reads DDL declares
   *  String columns, so a null team/chat id is stored as the empty string.
   *  Every failure is logged and dropped. */
  async record(event: SkillReadEvent): Promise<void> {
    try {
      // The DDL rides along with the first write (and startup ensures it);
      // a failed ensure is caught below with the insert — ClickHouse being
      // down drops the read, never breaks the turn.
      await this.ensureOnce();
      let teamId = event.team_id ?? "";
      if (event.team_id === null && this.pool !== null) {
        // Membership has no primary flag; the earliest-created team is primary.
        const res = await this.pool.query<{ id: string }>(
          "SELECT t.id FROM teams t JOIN team_members m ON m.team_id = t.id " +
            "WHERE m.user_id = $1 AND t.org_id = $2 ORDER BY t.created_at, t.id LIMIT 1",
          [event.user_id, event.org_id],
        );
        teamId = res.rows[0]?.id ?? "";
      }
      await this.client.insert("skill_reads", [
        {
          ts: clickhouseDateTime(event.ts),
          org_id: event.org_id,
          user_id: event.user_id,
          team_id: teamId,
          slug: event.slug,
          bundle_sha256: event.bundle_sha256,
          chat_id: event.chat_id ?? "",
        },
      ]);
    } catch (error) {
      console.warn(`skill read dropped: ${errorText(error)}`);
    }
  }

  /** Total reads of one skill over the last `days` days. Degrades to 0
   *  when the query fails (table not initialized yet). org_id is a String
   *  column in skill_reads, so it binds as a plain string. */
  async readsBySlug(orgId: string, slug: string, days: number): Promise<number> {
    try {
      const rows = await this.client.query(
        "SELECT count() AS reads FROM skill_reads " +
          "WHERE org_id = ? AND slug = ? AND ts >= toDateTime(?)",
        [orgId, slug, sinceEpochSeconds(days)],
      );
      return firstNumber(rows);
    } catch (error) {
      console.warn(`skill reads query failed: ${errorText(error)}`);
      return 0;
    }
  }

  /** Reads of one skill per day over the last `days` days, ordered by day.
   *  Degrades to an empty array when the query fails. */
  async readsByDay(
    orgId: string,
    slug: string,
    days: number,
  ): Promise<Array<{ day: string; reads: number }>> {
    try {
      const rows = await this.client.query(
        "SELECT toDate(ts) AS day, count() AS reads FROM skill_reads " +
          "WHERE org_id = ? AND slug = ? AND ts >= toDateTime(?) " +
          "GROUP BY day ORDER BY day",
        [orgId, slug, sinceEpochSeconds(days)],
      );
      return rows.map((row) => ({
        day: String(row["day"]),
        reads: toNumber(row["reads"]),
      }));
    } catch (error) {
      console.warn(`skill reads query failed: ${errorText(error)}`);
      return [];
    }
  }
}

function sinceEpochSeconds(days: number): number {
  return (Date.now() - days * 86_400_000) / 1000;
}

function firstNumber(rows: Record<string, unknown>[]): number {
  return toNumber(Object.values(rows[0] ?? {})[0]);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}
