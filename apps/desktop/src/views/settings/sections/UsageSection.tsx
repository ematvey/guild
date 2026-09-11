//! UsageSection — admin settings:
//! spend summary as stat cards plus a grouped usage breakdown table.

import { useEffect, useState } from "react";
import { api } from "../admin-api";

interface UsageRow {
  group: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  requests: number;
}

const card = "rounded-lg border border-border bg-card p-4";
const money = (v: number | undefined) => `$${(v ?? 0).toFixed(4)}`;
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

export default function UsageSection() {
  const [summary, setSummary] = useState<{ today_cost_usd: number; month_cost_usd: number } | null>(
    null,
  );
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [groupBy, setGroupBy] = useState("model");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api<{ today_cost_usd: number; month_cost_usd: number }>("GET", "/api/v1/usage/summary")
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    api<{ rows: UsageRow[] }>("GET", `/api/v1/usage?group_by=${groupBy}`)
      .then((r) => !cancelled && setRows(r.rows))
      .catch((e) => {
        if (!cancelled) {
          setRows([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [groupBy]);

  return (
    <div className="space-y-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* spend stat cards */}
      <div className="grid grid-cols-2 gap-3">
        {summary === null && error === null
          ? [0, 1].map((i) => (
              <div key={i} className={`${card} space-y-2`}>
                <div className="h-3 w-20 animate-pulse rounded bg-accent" />
                <div className="h-7 w-24 animate-pulse rounded bg-accent" />
              </div>
            ))
          : [
              { label: "Spent today", value: money(summary?.today_cost_usd) },
              { label: "Spent this month", value: money(summary?.month_cost_usd) },
            ].map((s) => (
              <div key={s.label} className={card}>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
              </div>
            ))}
      </div>

      {/* breakdown */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Usage breakdown
          </p>
          <div className="flex items-center gap-1">
            <span className="mr-1 text-xs text-muted-foreground">group by</span>
            {["user", "team", "model"].map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  groupBy === g
                    ? "bg-primary text-primary-foreground"
                    : "bg-accent/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
        {rows === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 w-full animate-pulse rounded-md bg-accent" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No usage yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium capitalize">{groupBy}</th>
                <th className="py-2 pr-3 font-medium">tokens in</th>
                <th className="py-2 pr-3 font-medium">tokens out</th>
                <th className="py-2 pr-3 font-medium">requests</th>
                <th className="py-2 pr-4 text-right font-medium">cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.group} className="border-t border-border/60">
                  <td className="max-w-48 truncate px-4 py-2 font-mono text-xs">{r.group}</td>
                  <td className="py-2 pr-3 tabular-nums">{compact(r.tokens_in)}</td>
                  <td className="py-2 pr-3 tabular-nums">{compact(r.tokens_out)}</td>
                  <td className="py-2 pr-3 tabular-nums">{compact(r.requests)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{money(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
