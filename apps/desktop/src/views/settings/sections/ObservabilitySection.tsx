//! ObservabilitySection — LLM call tracing (ClickHouse llm_calls): summary
//! cards, a filterable call table, and a per-row detail page with the stored
//! payloads (admin only). Admins see the org; members their own calls (the
//! API scopes by session, never by client input). The period and filters
//! live in the URL query, the open row in the /settings/observability/<id>
//! sub-page — back/forward, reloads and deep links restore the exact view.

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { apiMe } from "../../../transport";
import { quantizeIso, useCachedGet } from "../use-cached-api";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "../components/empty-state";
import type { SectionDetailProps } from "../section-nav";
import { filtersToQuery, readFiltersOf, type ObservabilityFilters } from "./observability-route";

interface CallRow {
  ts: string; // RFC 3339
  request_id: string;
  user_id: string;
  chat_id: string | null;
  conversation_id: number | null;
  turn: number | null;
  caller: string;
  cause: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  reasoning_tokens: number;
  cost_usd: number;
  duration_ms: number;
  finish_reason: string;
  stream: boolean;
  error: string;
  verdict: boolean | null;
  verdict_reason: string;
  prompt_chars: number;
  completion_chars: number;
}

interface SummaryRow {
  day: string;
  caller: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  reasoning_tokens: number;
  cost_usd: number;
  p50_ms: number;
  p95_ms: number;
}

const PERIODS = ["24h", "7d", "30d"] as const;
type Period = ObservabilityFilters["period"];
const PERIOD_MS: Record<Period, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

const CALLERS = ["all", "model", "judge"] as const;

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
const money = (v: number) => `$${v.toFixed(4)}`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Filters = ObservabilityFilters;
const readQuery = (): Filters => readFiltersOf(new URL(window.location.href));

/** API prefix for the caller's role: admins query the org-wide surface. */
const prefixFor = (role: string): string => (role === "admin" ? "/api/v1/admin/observability" : "/api/v1/observability");

export default function ObservabilitySection({ detail, onDetailChange }: SectionDetailProps) {
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    apiMe().then((u) => setRole(u?.role ?? "member"));
  }, []);

  if (detail !== null && detail !== undefined) {
    return <CallDetail requestId={decodeURIComponent(detail)} isAdmin={role === "admin"} onBack={() => onDetailChange(null)} />;
  }
  return <CallsDashboard role={role} onOpen={(id) => onDetailChange(encodeURIComponent(id))} />;
}

function CallsDashboard({ role, onOpen }: { role: string | null; onOpen: (id: string) => void }) {
  const [{ period, caller, model, chat }, setFilters] = useState<Filters>(readQuery);
  // Back/forward re-derive the filters from the URL.
  useEffect(() => {
    const onPop = () => setFilters(readQuery());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const set = (next: Partial<Filters>) => {
    const merged: Filters = { period, caller, model, chat, ...next };
    const url = new URL(window.location.href);
    filtersToQuery(merged, url);
    if (url.toString() !== window.location.href) window.history.pushState(null, "", url);
    setFilters(merged);
  };

  const admin = role === "admin";
  const prefix = role === null ? null : prefixFor(role);
  // Quantized bounds: cache keys repeat across navigations (10-minute
  // buckets); the upper bound reaches into the current bucket.
  const from = quantizeIso(600_000, Date.now() - PERIOD_MS[period]);
  const to = quantizeIso(600_000, Date.now() + 600_000);
  const qs = (extra = "") =>
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`;
  const callsRes = useCachedGet<{ calls: CallRow[]; total: number }>(
    prefix === null
      ? null
      : `${prefix}/calls?${qs(caller !== "all" ? `&caller=${caller}` : "")}${model ? `&model=${encodeURIComponent(model)}` : ""}${chat ? `&chat_id=${encodeURIComponent(chat)}` : ""}&limit=200`,
  );
  const summaryRes = useCachedGet<{ rows: SummaryRow[] }>(
    prefix === null ? null : `${prefix}/summary?${qs()}`,
  );

  const calls = callsRes.data?.calls ?? null;
  const summary = summaryRes.data?.rows ?? null;

  const modelTotals = summary?.filter((r) => r.caller === "model") ?? [];
  const judgeTotals = summary?.filter((r) => r.caller === "judge") ?? [];
  const sum = (rows: SummaryRow[], pick: (r: SummaryRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const p95 = (rows: SummaryRow[]) =>
    rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.p95_ms));

  const nothingRecorded = callsRes.settled && summaryRes.settled && (calls?.length ?? 0) === 0 && !callsRes.error && !summaryRes.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Observability"
        description={
          admin
            ? "Every LLM call in the workspace — model turns and approval judge verdicts — as stored in ClickHouse."
            : "Your LLM calls — model turns and approval judge verdicts — as stored in ClickHouse."
        }
        actions={<PeriodPicker period={period} onPick={(p) => set({ period: p })} />}
      />

      {/* summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Calls", value: compact(sum(modelTotals, (r) => r.calls) + sum(judgeTotals, (r) => r.calls)) },
          { label: "Tokens", value: compact(sum(modelTotals, (r) => r.tokens_in + r.tokens_out) + sum(judgeTotals, (r) => r.tokens_in + r.tokens_out)) },
          ...(admin ? [{ label: "Cost", value: money(sum(modelTotals, (r) => r.cost_usd) + sum(judgeTotals, (r) => r.cost_usd)) }] : []),
          { label: "Judge calls", value: compact(sum(judgeTotals, (r) => r.calls)) },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{card.value}</p>
          </div>
        ))}
      </div>

      {/* caller duration profile */}
      {summary !== null && summary.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Latency by caller</p>
          <div className="mt-3 space-y-2 text-sm">
            {["model", "judge"].map((kind) => {
              const rows = summary.filter((r) => r.caller === kind);
              if (rows.length === 0) return null;
              return (
                <div key={kind} className="flex items-center justify-between gap-4">
                  <span className="capitalize">{kind}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {compact(sum(rows, (r) => r.calls))} calls · p50 {ms(Math.max(...rows.map((r) => r.p50_ms)))} · p95{" "}
                    {ms(p95(rows))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* filters + call table */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-1">
            {CALLERS.map((c) => (
              <button
                key={c}
                onClick={() => set({ caller: c })}
                className={`rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                  caller === c ? "bg-primary text-primary-foreground" : "bg-accent/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <input
            value={model}
            onChange={(e) => set({ model: e.target.value })}
            placeholder="model filter"
            className="w-40 rounded-md border border-border bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground/60"
          />
          <input
            value={chat}
            onChange={(e) => set({ chat: e.target.value })}
            placeholder="chat id (uuid)"
            className="w-64 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs placeholder:text-muted-foreground/60"
          />
          <span className="ml-auto text-xs text-muted-foreground">{callsRes.data ? `${callsRes.data.total} call${callsRes.data.total === 1 ? "" : "s"}` : ""}</span>
        </div>

        {callsRes.error || summaryRes.error ? (
          <p className="p-4 text-sm text-destructive">
            {callsRes.error ?? summaryRes.error} — the trace lives in ClickHouse; check that it is reachable.
          </p>
        ) : calls === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-8 w-full animate-pulse rounded-md bg-accent" />
            ))}
          </div>
        ) : calls.length === 0 ? (
          nothingRecorded ? (
            <div className="p-4">
              <EmptyState
                icon={Activity}
                title="No LLM calls recorded in this window"
                hint="Tracing writes llm_calls rows on every gateway model call and judge verdict. If you expect traffic: the ClickHouse tables are created on first use — verify the server can reach ClickHouse, and that GUILD_TRACE_PAYLOADS is set only when payload bodies are wanted (metadata does not depend on it)."
              />
            </div>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No calls match the filters.</p>
          )
        ) : (
          <CallTable calls={calls} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}


function CallTable({ calls, onOpen }: { calls: CallRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="max-h-[28rem] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">time</th>
            <th className="py-2 pr-3 font-medium">caller</th>
            <th className="py-2 pr-3 font-medium">model</th>
            <th className="py-2 pr-3 font-medium">cause</th>
            <th className="py-2 pr-3 font-medium">tokens</th>
            <th className="py-2 pr-3 font-medium">p50 dur</th>
            <th className="py-2 pr-4 font-medium">outcome</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr
              key={c.request_id}
              onClick={() => onOpen(c.request_id)}
              className="cursor-pointer border-t border-border/60 hover:bg-accent/40"
            >
              <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">{time(c.ts)}</td>
              <td className="py-2 pr-3 capitalize">{c.caller}</td>
              <td className="max-w-40 truncate py-2 pr-3 font-mono text-xs">{c.model}</td>
              <td className="max-w-52 truncate py-2 pr-3 font-mono text-xs text-muted-foreground">{c.cause || "—"}</td>
              <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-xs">
                {compact(c.tokens_in)}→{compact(c.tokens_out)}
                {c.reasoning_tokens > 0 ? ` (+${compact(c.reasoning_tokens)} r)` : ""}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-xs">{ms(c.duration_ms)}</td>
              <td className="py-2 pr-4 text-xs">
                {c.error !== "" ? (
                  <span className="text-destructive">{c.error.slice(0, 60)}</span>
                ) : c.caller === "judge" ? (
                  <span className={c.verdict ? "text-green-600" : "text-amber-600"}>
                    {c.verdict === null ? "undecided" : c.verdict ? "approved" : "asked"}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{c.finish_reason || "—"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CallDetail({
  requestId,
  isAdmin,
  onBack,
}: {
  requestId: string;
  isAdmin: boolean;
  onBack: () => void;
}) {
  // The detail page needs a window wide enough to contain the row: 30 days
  // back is far beyond the 90-day TTL edge for realistic deep links.
  const wideFrom = quantizeIso(600_000, Date.now() - 30 * 24 * 3_600_000);
  const res = useCachedGet<{ calls: CallRow[] }>(
    `/api/v1/${isAdmin ? "admin/observability" : "observability"}/calls?request_id=${encodeURIComponent(requestId)}&from=${encodeURIComponent(wideFrom)}&limit=10`,
  );
  const payloadsRes = useCachedGet<{ payloads: { kind: string; body: string }[] }>(
    isAdmin ? `/api/v1/admin/observability/calls/${encodeURIComponent(requestId)}/payloads` : null,
  );
  const call = res.data?.calls?.[0] ?? null;

  return (
    <div className="space-y-5">
      <PageHeader title="Call detail" back={{ label: "Observability", onClick: onBack }} />
      {res.error !== null && <p className="text-sm text-destructive">{res.error}</p>}
      {call === null ? (
        res.settled ? (
          <EmptyState icon={Activity} title="Call not found" hint={`No llm_calls row for ${requestId} in the last 30 days.`} />
        ) : (
          <div className="h-32 w-full animate-pulse rounded-lg bg-accent" />
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {[
              ["Caller", call.caller],
              ["Model", `${call.model} (${call.provider})`],
              ["Time", time(call.ts)],
              ["Duration", ms(call.duration_ms)],
              ["Tokens", `${call.tokens_in} in / ${call.tokens_out} out${call.reasoning_tokens > 0 ? ` / ${call.reasoning_tokens} reasoning` : ""}`],
              ["Cost", money(call.cost_usd)],
              ["Finish reason", call.finish_reason || "—"],
              ["Stream", call.stream ? "streaming" : "non-streaming"],
              ["Chars", `${call.prompt_chars} prompt / ${call.completion_chars} completion`],
              ["Chat", call.chat_id ?? "—"],
              ["Conversation / turn", call.conversation_id === null ? "—" : `${call.conversation_id} / ${call.turn ?? "—"}`],
              ["Request id", call.request_id],
              ...(call.caller === "judge"
                ? [
                    ["Verdict", call.verdict === null ? "undecided" : call.verdict ? "approved" : "asked the user"],
                    ["Verdict reason", call.verdict_reason || "—"],
                  ]
                : []),
              ...(call.error !== "" ? ([["Error", call.error]] as [string, string][]) : []),
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="mt-1 break-all font-mono text-xs">{value}</p>
              </div>
            ))}
          </div>
          {isAdmin && (
            <div className="rounded-lg border border-border bg-card">
              <p className="border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Payloads {payloadsRes.data && payloadsRes.data.payloads.length === 0 ? "(none stored — payload tracing is off)" : ""}
              </p>
              {(payloadsRes.data?.payloads ?? []).map((p) => (
                <div key={p.kind} className="border-b border-border/60 px-4 py-3 last:border-0">
                  <p className="mb-1 text-xs capitalize text-muted-foreground">{p.kind}</p>
                  <pre className="max-h-72 overflow-auto rounded bg-accent/50 p-2 font-mono text-xs whitespace-pre-wrap break-all">
                    {p.body}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
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
            period === p ? "bg-primary text-primary-foreground" : "bg-accent/50 text-muted-foreground hover:text-foreground"
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

