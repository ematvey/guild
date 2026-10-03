// Usage-event sink — ClickHouse (crates/server/src/usage.rs port). The
// shared usage_events table/columns; unreachable ClickHouse must never
// break model calls: failures are logged and dropped.

import { clickhouseDateTime, ClickhouseClient } from "./clickhouse.js";
import { uuidv7 } from "./time.js";
import { ApiError } from "./http/error.js";
import type { PlatformPool } from "./db.js";

export interface UsageEvent {
  ts: Date;
  org_id: string;
  user_id: string;
  team_id: string | null;
  session_id: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  request_id: string;
}

/** Cost from org-configured per-model prices (USD per million tokens). */
export function usageCostUsd(tokensIn: number, tokensOut: number, priceIn: number, priceOut: number): number {
  return (tokensIn / 1_000_000) * priceIn + (tokensOut / 1_000_000) * priceOut;
}

export class UsageSink {
  private pool: PlatformPool | null = null;
  private ready: Promise<void> | null = null;

  constructor(readonly client: ClickhouseClient) {}

  attachPool(pool: PlatformPool): void {
    this.pool = pool;
  }

  /** The table-creation DDL the Rust sink runs on connect; runs once per
   *  sink. Callers that need the table to exist (quota reads) await this. */
  ensureOnce(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.client.ensureUsageTable();
    }
    return this.ready;
  }

  /** Records one event; team attribution fills the user's earliest team.
   *  Every failure is logged and dropped (spec: ClickHouse unavailability
   *  never breaks a model call). */
  async record(event: UsageEvent): Promise<void> {
    try {
      let teamId = event.team_id;
      if (teamId === null && this.pool !== null) {
        // Membership has no primary flag; the earliest-created team is primary.
        const res = await this.pool.query<{ id: string }>(
          "SELECT t.id FROM teams t JOIN team_members m ON m.team_id = t.id " +
            "WHERE m.user_id = $1 AND t.org_id = $2 ORDER BY t.created_at, t.id LIMIT 1",
          [event.user_id, event.org_id],
        );
        teamId = res.rows[0]?.id ?? null;
      }
      await this.client.insert("usage_events", [
        {
          ts: clickhouseDateTime(event.ts),
          org_id: event.org_id,
          user_id: event.user_id,
          team_id: teamId,
          session_id: event.session_id,
          model: event.model,
          provider: event.provider,
          tokens_in: event.tokens_in,
          tokens_out: event.tokens_out,
          cost_usd: event.cost_usd,
          request_id: event.request_id,
        },
      ]);
    } catch (error) {
      console.warn(`usage event dropped: ${errorText(error)}`);
    }
  }

  /** Month-to-date spend for one (org, model) — quota enforcement
   *  (spec §4.5). Degrades to 0.0 when the table is not initialized yet. */
  async monthSpend(orgId: string, model: string): Promise<number> {
    const startOfMonth = startOfMonthUtc();
    const rows = await this.client.query(
      "SELECT coalesce(sum(cost_usd), 0) FROM (SELECT * FROM usage_events " +
        "WHERE org_id = toUUID(?) AND model = ? AND ts >= toDateTime(?) " +
        "ORDER BY ts DESC LIMIT 1 BY org_id, request_id)",
      [orgId, model, startOfMonth.getTime() / 1000],
    );
    return firstNumber(rows);
  }
}

/** Route quota enforcement (spec §4.5): reject when month-to-date spend for
 *  (org, model) has reached the route's monthly cap. */
export async function enforceQuota(
  usage: UsageSink,
  orgId: string,
  model: string,
  route: { quotaMonthlyUsd: number | null },
): Promise<void> {
  if (route.quotaMonthlyUsd === null) return;
  const spent = await usage.monthSpend(orgId, model).catch((error: unknown) => {
    throw ApiError.internal(`quota check failed: ${errorText(error)}`);
  });
  if (spent >= route.quotaMonthlyUsd) {
    throw new ApiError(
      429,
      "quota_exceeded",
      `monthly quota for this model reached (${spent.toFixed(2)} >= ${route.quotaMonthlyUsd.toFixed(2)} USD)`,
    );
  }
}

export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function startOfDayUtc(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function newRequestId(): string {
  return uuidv7();
}

function firstNumber(rows: Record<string, unknown>[]): number {
  const value = Object.values(rows[0] ?? {})[0];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
