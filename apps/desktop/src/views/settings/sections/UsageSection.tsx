//! UsageSection — admin settings: spend summary cards, a cost-over-time
//! chart, a per-group breakdown (table + bars), all scoped by a period
//! selector. The period and group live in the URL (?period=&group=), so
//! back/forward, reloads and deep links restore the exact view.

import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "../admin-api";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@guild/ui/components/chart";

interface UsageRow {
  group: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  requests: number;
}

interface SeriesRow {
  bucket: string; // RFC 3339
  group: string;
  cost_usd: number;
  requests: number;
}

const card = "rounded-lg border border-border bg-card p-4";
const money = (v: number | undefined) => `$${(v ?? 0).toFixed(4)}`;
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

const PERIODS = ["24h", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_MS: Record<Period, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

const GROUPS = ["user", "team", "model"] as const;
type Group = (typeof GROUPS)[number];

const readQuery = (): { period: Period; group: Group } => {
  const q = new URLSearchParams(window.location.search);
  const period = q.get("period") as Period | null;
  const group = q.get("group") as Group | null;
  return {
    period: (PERIODS as readonly string[]).includes(period ?? "") ? period! : "7d",
    group: (GROUPS as readonly string[]).includes(group ?? "") ? group! : "model",
  };
};

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hourLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" });
const fullStamp = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });

export default function UsageSection() {
  const [summary, setSummary] = useState<{ today_cost_usd: number; month_cost_usd: number } | null>(
    null,
  );
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [timeline, setTimeline] = useState<
    { label: string; stamp: string; cost: number; requests: number }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [{ period, group }, setView] = useState(readQuery);

  // Back/forward: re-read period + group from the URL.
  useEffect(() => {
    const onPop = () => setView(readQuery());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const pick = (next: Partial<{ period: Period; group: Group }>) => {
    const merged = { period, group, ...next };
    const url = new URL(window.location.href);
    url.searchParams.set("period", merged.period);
    url.searchParams.set("group", merged.group);
    if (url.toString() !== window.location.href) {
      window.history.pushState(null, "", url);
    }
    setView(merged);
  };

  useEffect(() => {
    setError(null);
    api<{ today_cost_usd: number; month_cost_usd: number }>("GET", "/api/v1/usage/summary")
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setTimeline(null);
    const from = new Date(Date.now() - PERIOD_MS[period]).toISOString();
    const to = new Date().toISOString();
    // zero-filled timeline keeps lines continuous across traffic gaps
    const buckets = period === "24h" ? 24 : PERIOD_MS[period] / 86_400_000;
    const labelOf = period === "24h" ? hourLabel : dayLabel;
    void (async () => {
      try {
        const [breakdown, series] = await Promise.all([
          api<{ rows: UsageRow[] }>(
            "GET",
            `/api/v1/usage?group_by=${group}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          ),
          api<{ rows: SeriesRow[] }>(
            "GET",
            `/api/v1/usage/series?group_by=none&bucket=${period === "24h" ? "hour" : "day"}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          ),
        ]);
        if (cancelled) return;
        setRows(breakdown.rows);
        // sum across groups → single timeline; keyed by epoch ms (server
        // buckets arrive as RFC 3339 UTC instants)
        const byStamp = new Map<number, { cost: number; requests: number }>();
        for (const r of series.rows) {
          const key = new Date(r.bucket).getTime();
          const cur = byStamp.get(key) ?? { cost: 0, requests: 0 };
          byStamp.set(key, { cost: cur.cost + r.cost_usd, requests: cur.requests + r.requests });
        }
        const points: { label: string; stamp: string; cost: number; requests: number }[] = [];
        const step = PERIOD_MS[period] / buckets;
        const start = Date.now() - PERIOD_MS[period];
        for (let i = 1; i <= buckets; i++) {
          // bucket START times, aligned to UTC hour/day boundaries to match
          // the server's toStartOfHour/toStartOfDay buckets
          const tMs =
            period === "24h"
              ? Math.floor((start + i * step) / 3_600_000) * 3_600_000
              : Math.floor((start + i * step) / 86_400_000) * 86_400_000;
          const iso = new Date(tMs).toISOString();
          points.push({
            label: labelOf(iso),
            stamp: iso,
            cost: byStamp.get(tMs)?.cost ?? 0,
            requests: byStamp.get(tMs)?.requests ?? 0,
          });
        }
        setTimeline(points);
      } catch (e) {
        if (!cancelled) {
          setRows([]);
          setTimeline([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period, group]);

  const barRows = (rows ?? [])
    .slice()
    .sort((a, b) => b.cost_usd - a.cost_usd || b.requests - a.requests)
    .slice(0, 8)
    .map((r) => ({
      group: r.group === "none" && group === "team" ? "no team" : r.group,
      cost: r.cost_usd,
      requests: r.requests,
    }));
  const barsByRequests = barRows.some((r) => r.requests > 0) && barRows.every((r) => r.cost === 0);

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

      {/* cost over time */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Usage, last {period}
          </p>
          <PeriodPicker period={period} onPick={(p) => pick({ period: p })} />
        </div>
        <div className="p-4">
          {timeline === null ? (
            <div className="h-40 w-full animate-pulse rounded-md bg-accent" />
          ) : timeline.every((p) => p.cost === 0 && p.requests === 0) ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No usage in the last {period}.
            </p>
          ) : (
            <CostChart timeline={timeline} />
          )}
        </div>
      </div>

      {/* breakdown: bars + table */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Usage breakdown
          </p>
          <div className="flex items-center gap-3">
            <PeriodPicker period={period} onPick={(p) => pick({ period: p })} />
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs text-muted-foreground">group by</span>
              {GROUPS.map((g) => (
                <button
                  key={g}
                  onClick={() => pick({ group: g })}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${
                    group === g
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent/50 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        </div>
        {rows !== null && rows.length > 0 && (
          <div className="border-b border-border px-4 py-4">
            <ChartContainer
              config={{
                [barsByRequests ? "requests" : "cost"]: {
                  label: barsByRequests ? "Requests" : "Cost",
                  color: "var(--primary)",
                },
              }}
              className="aspect-auto w-full"
              style={{ height: barRows.length * 34 + 8 }}
            >
              <BarChart data={barRows} layout="vertical" margin={{ left: 4, right: 12 }}>
                <XAxis type="number" hide />
                <YAxis
                  dataKey="group"
                  type="category"
                  width={150}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        barsByRequests
                          ? `${Number(value).toLocaleString()} requests`
                          : money(Number(value))
                      }
                      hideLabel
                    />
                  }
                />
                <Bar
                  dataKey={barsByRequests ? "requests" : "cost"}
                  fill="var(--color-cost)"
                  radius={4}
                  barSize={14}
                />
              </BarChart>
            </ChartContainer>
          </div>
        )}
        {rows === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 w-full animate-pulse rounded-md bg-accent" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No usage in the last {period}.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium capitalize">{group}</th>
                <th className="py-2 pr-3 font-medium">tokens in</th>
                <th className="py-2 pr-3 font-medium">tokens out</th>
                <th className="py-2 pr-3 font-medium">requests</th>
                <th className="py-2 pr-4 text-right font-medium">cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.group} className="border-t border-border/60">
                  {/* emails/team names read as text; model ids stay mono */}
                  <td
                    className={`max-w-48 truncate px-4 py-2 text-xs ${
                      group === "model" ? "font-mono" : ""
                    }`}
                  >
                    {r.group === "none" && group === "team" ? "no team" : r.group}
                  </td>
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

/// Cost-over-time area chart; on free ($0/Mtok) routes cost is flat zero,
/// so the chart falls back to request volume — still a real usage signal.
function CostChart({
  timeline,
}: {
  timeline: { label: string; stamp: string; cost: number; requests: number }[];
}) {
  const byRequests = timeline.some((p) => p.requests > 0) && timeline.every((p) => p.cost === 0);
  const config = {
    [byRequests ? "requests" : "cost"]: {
      label: byRequests ? "Requests" : "Cost",
      color: "var(--primary)",
    },
  } satisfies ChartConfig;
  const dataKey = byRequests ? "requests" : "cost";
  return (
    <ChartContainer config={config} className="aspect-auto h-44 w-full">
      <AreaChart data={timeline} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v: number) =>
            dataKey === "cost"
              ? `$${v < 0.01 && v > 0 ? v.toFixed(3) : v.toFixed(2)}`
              : compact(v)
          }
        />
        <ChartTooltip
          cursor={{ stroke: "var(--border)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const stamp = (payload?.[0]?.payload as { stamp?: string } | undefined)?.stamp;
                return stamp ? fullStamp(stamp) : "";
              }}
              formatter={(value) =>
                dataKey === "cost" ? money(Number(value)) : `${Number(value).toLocaleString()} requests`
              }
            />
          }
        />
        <Area
          dataKey={dataKey}
          type="monotone"
          stroke="var(--color-cost)"
          fill="var(--color-cost)"
          fillOpacity={0.12}
          strokeWidth={1.5}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function PeriodPicker({ period, onPick }: { period: Period; onPick: (p: Period) => void }) {
  return (
    <div className="flex items-center gap-1">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => onPick(p)}
          className={`rounded-md px-2 py-1 text-xs transition-colors ${
            period === p
              ? "bg-primary text-primary-foreground"
              : "bg-accent/50 text-muted-foreground hover:text-foreground"
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
