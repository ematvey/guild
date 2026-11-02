//! UsageSection — admin settings: spend summary cards, a cost-over-time
//! chart, a per-group breakdown (table + bars), all scoped by a period
//! selector. The period, group and metric ride in the route query
//! (?period=&group=&metric=), so back/forward, reloads and deep links
//! restore the exact view.

import { Skeleton, SkeletonRows } from "@guild/ui/components/skeleton";
import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { quantizeIso, useCachedGet } from "../use-cached-api";
import {
  DEFAULT_USAGE,
  USAGE_GROUPS as GROUPS,
  USAGE_METRICS as METRICS,
  USAGE_PERIODS as PERIODS,
  type UsageMetric as Metric,
  type UsagePeriod as Period,
  type UsageQuery,
} from "../usage-route";
import { SETTINGS_PATHS, usageBreakdownPath, usageSeriesPath } from "../../../lib/api/settings";
import type { SectionDetailProps } from "../section-nav";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@guild/ui/components/chart";
import { PageHeader } from "../../../components/page-header";

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
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  requests: number;
}

const card = "rounded-lg border border-border bg-card p-4";
const money = (v: number | undefined) => `$${(v ?? 0).toFixed(4)}`;
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

const PERIOD_MS: Record<Period, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" });
const fullStamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });

export default function UsageSection({ usage = DEFAULT_USAGE, onUsageChange }: SectionDetailProps) {
  const summaryRes = useCachedGet<{
    today_cost_usd: number;
    month_cost_usd: number;
    today_tokens?: number;
    month_tokens?: number;
  }>(SETTINGS_PATHS.usageSummary);
  const summary = summaryRes.data;
  const { period, group, metric } = usage;

  const pick = (next: Partial<UsageQuery>) => {
    onUsageChange?.({ period, group, metric, ...next });
  };

  // Query paths quantize timestamps to 10-minute buckets so cache keys
  // repeat across navigations instead of changing every mount. The upper
  // bound quantizes UP: an inclusive `ts <= to` filter must reach into the
  // current (partial) bucket or the newest events never appear.
  const from = quantizeIso(600_000, Date.now() - PERIOD_MS[period]);
  const to = quantizeIso(600_000, Date.now() + 600_000);
  const breakdownRes = useCachedGet<{ rows: UsageRow[] }>(usageBreakdownPath(group, from, to));
  const seriesRes = useCachedGet<{ rows: SeriesRow[] }>(
    usageSeriesPath("none", period === "24h" ? "hour" : "day", from, to),
  );
  const rows = breakdownRes.data?.rows ?? null;
  const error = summaryRes.error ?? breakdownRes.error ?? seriesRes.error;

  // zero-filled timeline keeps lines continuous across traffic gaps
  const timeline = useMemo<
    { label: string; stamp: string; cost: number; tokens: number; requests: number }[] | null
  >(() => {
    const series = seriesRes.data?.rows;
    if (!series) return null;
    const buckets = period === "24h" ? 24 : PERIOD_MS[period] / 86_400_000;
    const labelOf = period === "24h" ? hourLabel : dayLabel;
    const byStamp = new Map<number, { cost: number; tokens: number; requests: number }>();
    for (const r of series) {
      const key = new Date(r.bucket).getTime();
      const cur = byStamp.get(key) ?? { cost: 0, tokens: 0, requests: 0 };
      byStamp.set(key, {
        cost: cur.cost + r.cost_usd,
        tokens: cur.tokens + r.tokens_in + r.tokens_out,
        requests: cur.requests + r.requests,
      });
    }
    const points: { label: string; stamp: string; cost: number; tokens: number; requests: number }[] = [];
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
        tokens: byStamp.get(tMs)?.tokens ?? 0,
        requests: byStamp.get(tMs)?.requests ?? 0,
      });
    }
    return points;
  }, [seriesRes.data, period]);

  const tokensOf = (r: UsageRow) => r.tokens_in + r.tokens_out;
  const barRows = (rows ?? [])
    .slice()
    .sort((a, b) =>
      metric === "tokens"
        ? tokensOf(b) - tokensOf(a) || b.requests - a.requests
        : b.cost_usd - a.cost_usd || b.requests - a.requests,
    )
    .slice(0, 8)
    .map((r) => ({
      group: r.group === "none" && group === "team" ? "no team" : r.group,
      cost: r.cost_usd,
      tokens: tokensOf(r),
      requests: r.requests,
    }));
  const barsByRequests =
    barRows.some((r) => r.requests > 0) && barRows.every((r) => (metric === "tokens" ? r.tokens === 0 : r.cost === 0));
  const barDataKey = barsByRequests ? "requests" : metric;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Usage"
        description="Spend and request volume across the organization, scoped by period."
        actions={<MetricPicker metric={metric} onPick={(m) => pick({ metric: m })} />}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* spend stat cards */}
      <div className="grid grid-cols-2 gap-3">
        {summary === null && summaryRes.error === null
          ? [0, 1].map((i) => (
              <div key={i} className={`${card} space-y-2`}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-24" />
              </div>
            ))
          : [
              metric === "tokens"
                ? [
                    { label: "Tokens today", value: summary ? compact(summary.today_tokens ?? 0) : "—" },
                    { label: "Tokens this month", value: summary ? compact(summary.month_tokens ?? 0) : "—" },
                  ]
                : [
                    { label: "Spent today", value: summary ? money(summary.today_cost_usd) : "—" },
                    { label: "Spent this month", value: summary ? money(summary.month_cost_usd) : "—" },
                  ],
            ]
              .flat()
              .map((s) => (
                <div key={s.label} className={card}>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
                </div>
              ))}
      </div>

      {/* cost over time */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Usage, last {period}</p>
          <PeriodPicker period={period} onPick={(p) => pick({ period: p })} />
        </div>
        <div className="p-4">
          {timeline === null && seriesRes.error ? (
            <p role="alert" className="text-sm text-destructive">
              {seriesRes.error}
            </p>
          ) : timeline === null ? (
            <div
              role="status"
              aria-label="Loading usage chart"
              className="flex h-40 items-end gap-4 border-b border-border px-4 pb-1"
            >
              {[35, 55, 40, 70, 50, 65, 45].map((height, i) => (
                <Skeleton key={i} className="flex-1 rounded-sm" style={{ height: `${height}%` }} />
              ))}
            </div>
          ) : timeline.every((p) => p.cost === 0 && p.requests === 0) ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No usage in the last {period}.</p>
          ) : (
            <CostChart timeline={timeline} metric={metric} />
          )}
        </div>
      </div>

      {/* breakdown: bars + table */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Usage breakdown</p>
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
                [barDataKey]: {
                  label: barsByRequests ? "Requests" : metric === "tokens" ? "Tokens" : "Cost",
                  color: "var(--primary)",
                },
              }}
              className="aspect-auto w-full"
              style={{ height: barRows.length * 34 + 8 }}
            >
              <BarChart data={barRows} layout="vertical" margin={{ left: 4, right: 12 }}>
                <XAxis type="number" hide />
                <YAxis dataKey="group" type="category" width={150} tickLine={false} axisLine={false} />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        barsByRequests
                          ? `${Number(value).toLocaleString()} requests`
                          : metric === "tokens"
                            ? `${compact(Number(value))} tokens`
                            : money(Number(value))
                      }
                      hideLabel
                    />
                  }
                />
                <Bar dataKey={barDataKey} fill={`var(--color-${barDataKey})`} radius={4} barSize={14} />
              </BarChart>
            </ChartContainer>
          </div>
        )}
        {rows === null && breakdownRes.error ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {breakdownRes.error}
          </p>
        ) : rows === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <SkeletonRows key={i} rows={1} />
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
                  <td className={`max-w-48 truncate px-4 py-2 text-xs ${group === "model" ? "font-mono" : ""}`}>
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

/// Cost-or-tokens over time area chart; the metric follows the page toggle.
/// On free ($0/Mtok) routes the cost view is flat zero, so the chart falls
/// back to request volume — still a real usage signal.
function CostChart({
  timeline,
  metric,
}: {
  timeline: { label: string; stamp: string; cost: number; tokens: number; requests: number }[];
  metric: Metric;
}) {
  const byRequests =
    timeline.some((p) => p.requests > 0) &&
    timeline.every((p) => (metric === "tokens" ? p.tokens === 0 : p.cost === 0));
  const dataKey = byRequests ? "requests" : metric;
  const config = {
    [dataKey]: {
      label: byRequests ? "Requests" : metric === "tokens" ? "Tokens" : "Cost",
      color: "var(--primary)",
    },
  } satisfies ChartConfig;
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
            dataKey === "cost" ? `$${v < 0.01 && v > 0 ? v.toFixed(3) : v.toFixed(2)}` : compact(v)
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
                dataKey === "cost"
                  ? money(Number(value))
                  : dataKey === "tokens"
                    ? `${compact(Number(value))} tokens`
                    : `${Number(value).toLocaleString()} requests`
              }
            />
          }
        />
        <Area
          dataKey={dataKey}
          type="monotone"
          stroke={`var(--color-${dataKey})`}
          fill={`var(--color-${dataKey})`}
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

function MetricPicker({ metric, onPick }: { metric: Metric; onPick: (m: Metric) => void }) {
  return (
    <div className="flex items-center gap-1">
      {METRICS.map((m) => (
        <button
          key={m}
          onClick={() => onPick(m)}
          className={`rounded-md px-2 py-1 text-xs capitalize transition-colors ${
            metric === m
              ? "bg-primary text-primary-foreground"
              : "bg-accent/50 text-muted-foreground hover:text-foreground"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
