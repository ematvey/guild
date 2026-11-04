// An installed integration's usage: calls, failures, latency and who calls
// it, over a window, read from the integration's audit events. Windowed
// analytics — read on open and on Refresh, never live.

import { Bar, BarChart, XAxis } from "recharts";
import { RefreshCw } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@guild/ui/components/chart";
import { useCachedGet } from "../settings/use-cached-api";
import { integrationUsagePath, type IntegrationUsage } from "./integrations-api";
import { compactCount } from "./model";

export function useIntegrationUsage(id: string, days: number) {
  return useCachedGet<IntegrationUsage>(integrationUsagePath(id, days));
}

/** Every day of the window, oldest first, zero-filled. */
export function dailySeries(
  usage: IntegrationUsage,
  today = new Date(),
): { day: string; ok: number; failed: number }[] {
  const byDay = new Map(usage.by_day.map((d) => [d.day, d]));
  const out: { day: string; ok: number; failed: number }[] = [];
  for (let i = usage.days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    out.push({ day: key, ok: row ? row.calls - row.errors : 0, failed: row?.errors ?? 0 });
  }
  return out;
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "—" : `${((part / whole) * 100).toFixed(part / whole < 0.1 && part > 0 ? 1 : 0)}%`;
const millis = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function UsageStats({ usage }: { usage: IntegrationUsage }) {
  const t = usage.totals;
  const stats: [string, string][] = [
    ["Calls", compactCount(t.calls)],
    ["Failed", percent(t.errors, t.calls)],
    ["Typical latency", millis(t.p50_ms)],
    ["Slowest 5%", millis(t.p95_ms)],
    ["People", String(t.people)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-5">
      {stats.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CallsChart({ usage, height = 160 }: { usage: IntegrationUsage; height?: number }) {
  const series = dailySeries(usage);
  return (
    <ChartContainer
      config={{
        ok: { label: "Succeeded", color: "var(--foreground)" },
        failed: { label: "Failed", color: "var(--destructive)" },
      }}
      className="aspect-auto w-full"
      style={{ height }}
    >
      <BarChart data={series} margin={{ left: 0, right: 0, top: 4, bottom: 0 }} barCategoryGap={2}>
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={48}
          tickFormatter={(d: string) =>
            new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })
          }
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar dataKey="ok" stackId="calls" fill="var(--color-ok)" fillOpacity={0.75} radius={[0, 0, 2, 2]} />
        <Bar dataKey="failed" stackId="calls" fill="var(--color-failed)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          {head.map((h, i) => (
            <th key={h} className={`py-2 font-medium ${i === 0 ? "pr-4" : "px-2 text-right"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, r) => (
          <tr key={r} className="border-b border-border/60">
            {cells.map((c, i) => (
              <td key={i} className={`py-2 ${i === 0 ? "pr-4" : "px-2 text-right tabular-nums text-muted-foreground"}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsageTab({ id }: { id: string }) {
  const res = useIntegrationUsage(id, 30);
  const usage = res.data;
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Last 30 days</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every call agents and scripts made through this integration.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => res.reload()}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>
      {res.error ? (
        <p role="alert" className="mt-6 text-sm text-destructive">
          {res.error}
        </p>
      ) : usage === null ? (
        <div className="mt-6 space-y-3">
          <SkeletonRows rows={5} />
        </div>
      ) : usage.totals.calls === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No calls in the last 30 days. Usage shows up here once an agent calls one of the tools.
        </p>
      ) : (
        <>
          <div className="mt-6">
            <UsageStats usage={usage} />
          </div>
          <div className="mt-8">
            <CallsChart usage={usage} height={200} />
          </div>
          <div className="mt-10 grid gap-10 xl:grid-cols-2">
            <section>
              <h3 className="mb-2 text-sm font-medium">By tool</h3>
              <Table
                head={["Tool", "Calls", "Failed", "Slowest 5%"]}
                rows={usage.by_tool.map((t) => [
                  <span className="font-mono text-xs">{t.tool}</span>,
                  compactCount(t.calls),
                  t.errors === 0 ? "—" : String(t.errors),
                  millis(t.p95_ms),
                ])}
              />
            </section>
            <section>
              <h3 className="mb-2 text-sm font-medium">By person</h3>
              <Table
                head={["Person", "Calls", "Failed", "Last call"]}
                rows={usage.by_person.map((p) => [
                  p.name,
                  compactCount(p.calls),
                  p.errors === 0 ? "—" : String(p.errors),
                  when(p.last_call_at),
                ])}
              />
            </section>
          </div>
          {usage.recent_failures.length > 0 && (
            <section className="mt-10">
              <h3 className="mb-2 text-sm font-medium">Recent failures</h3>
              <ul className="divide-y divide-border border-y border-border">
                {usage.recent_failures.map((f, i) => (
                  <li key={i} className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
                    <div className="text-xs text-muted-foreground">
                      <p>{when(f.at)}</p>
                      <p className="mt-0.5">
                        {f.name ?? "Unknown caller"} · {f.via === "script" ? "script" : "chat"}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="font-mono text-xs">{f.tool}</p>
                      <p className="mt-1 break-words text-sm text-destructive">{f.error}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
