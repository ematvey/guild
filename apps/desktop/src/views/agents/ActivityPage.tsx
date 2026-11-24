// Activity: one observability surface for agent work, read top-down. A
// conversation is one chat; the conversation view is its high-level
// transcript (trigger message, one row per run, the agent's reply), and a
// run row opens the run detail with every model and tool call until the
// agent stopped. Conversations and runs read Postgres; model calls and the
// summary read ClickHouse. Navigation stays in the URL: the tab, period and
// filters ride the query, the open run is /runs/<id>, the conversation is
// /chats/<id>.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronRight,
  Coins,
  CornerUpLeft,
  MessageSquare,
  RefreshCw,
  Search,
  Timer,
  User,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@guild/ui/components/button";
import { cn } from "@guild/ui/lib/utils";
import { ACTIVITY_CONVERSATION_PAGE, type ConversationSnapshot } from "@guild/wire/rest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import {
  AGENTS_ACTIVITY,
  RUN_STATUS_LABEL,
  RUN_TRIGGER_LABEL,
  agentsRoutePath,
  type ActivityFilters,
  type ActivityPeriod,
  type ActivityTab,
  type AgentsRoute,
} from "./agents-route";
import {
  getActivitySummary,
  getConversation,
  listConversations,
  listSpans,
  listTraces,
  type ActivityQuery,
  type ActivitySummary,
  type ConversationDetail,
  type ConversationItem,
  type ConversationRow,
  type ConversationRunItem,
  type SpanRow,
  type TraceRow,
} from "./agents-api";
import type { AgentRun } from "./agents-api";
import {
  summaryWithTrace,
  traceFromRun,
  traceWithRun,
  useActivityRunUpdates,
  useActivityConversationUpdates,
  useAgentConnectionEpoch,
} from "./agents-store";
import { AgentGlyph, ErrorState, InlineLoading, LoadingRows, PageBody, TabBar, ToneBadge } from "./agent-ui";
import { PageHeader } from "../../components/page-header";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import { count } from "../../lib/format";
import { useDebounced } from "../../lib/use-debounced";
import { compact, money, ms, time, toneOf, totalTokens, triggerLabel, statusLabel } from "./activity-format";
import { EmptyState } from "@guild/ui/components/empty-state";

const PERIODS: ReadonlyArray<readonly [ActivityPeriod, string]> = [
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
];
const PERIOD_MS: Record<ActivityPeriod, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};
const ACTIVITY_TABS: ReadonlyArray<readonly [ActivityTab, string]> = [
  ["chats", "Threads"],
  ["traces", "Runs"],
  ["calls", "Model calls"],
];
const STATUSES = ["queued", "running", "succeeded", "failed", "silent", "skipped"] as const;
const TRIGGERS = ["message", "routine", "manual", "delegation"] as const;
/** True when a run that is new to the traces table belongs in it: same
 *  agent projection, status and trigger filters, and no text search (the
 *  search runs over trace-store fields the run frame does not carry). */
export function runMatchesFilters(run: AgentRun, filters: ActivityFilters, agentId?: string): boolean {
  if (agentId !== undefined && run.agent_id !== agentId) return false;
  if (filters.status !== "all" && run.status !== filters.status) return false;
  if (filters.trigger !== "all" && run.trigger !== filters.trigger) return false;
  return filters.q.trim() === "";
}

const SEARCH_DEBOUNCE_MS = 300;

function windowQuery(period: ActivityPeriod): ActivityQuery {
  const now = Date.now();
  return {
    from: new Date(now - PERIOD_MS[period]).toISOString(),
    to: new Date(now + 60_000).toISOString(),
  };
}

export function ActivityPage({
  filters,
  onFiltersChange,
  onNavigate,
  onOpenChat,
  agentId,
  embedded = false,
  role,
}: {
  /** The activity filters named by the route. */
  filters: ActivityFilters;
  /** `replace` rewrites the current history entry: typing in a filter box
   *  is one edit, not a step per keystroke. */
  onFiltersChange: (filters: ActivityFilters, options?: { replace?: boolean }) => void;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
  /** Per-agent projection when set. */
  agentId?: string;
  embedded?: boolean;
  /** The signed-in user's workspace role. */
  role: string;
}) {
  const [summarySeed, setSummary] = useState<ActivitySummary | null>(null);
  const [traceSeed, setTraceSeed] = useState<Awaited<ReturnType<typeof listTraces>> | null>(null);
  const [spans, setSpans] = useState<SpanRow[] | null>(null);
  const [conversationSeed, setConversations] = useState<ConversationRow[] | null>(null);
  const [updates, setUpdates] = useState<{
    scope: string;
    epoch: number;
    runs?: ReadonlyMap<string, AgentRun>;
    counts?: Record<string, Pick<ConversationRow, "runs" | "open_runs" | "failed_runs">>;
  } | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const set = (next: Partial<ActivityFilters>, options?: { replace?: boolean }) => {
    onFiltersChange({ ...filters, ...next }, options);
  };

  // The text filters fetch once typing pauses; the URL follows every key.
  const q = useDebounced(filters.q.trim(), SEARCH_DEBOUNCE_MS);
  const model = useDebounced(filters.model, SEARCH_DEBOUNCE_MS);
  const admin = role === "admin";
  const background = admin && filters.background;
  const { tab, period, status, trigger, caller } = filters;
  const connectionEpoch = useAgentConnectionEpoch();
  const seedEpoch = tab === "calls" ? 0 : connectionEpoch;
  const scope = JSON.stringify([tab, period, status, trigger, q, caller, model, agentId, background, tick, role]);
  const pushed = updates?.scope === scope && updates.epoch === seedEpoch ? updates : null;
  const conversations = useMemo(
    () => conversationSeed?.map((row) => ({ ...row, ...pushed?.counts?.[row.thread?.id ?? ""] })) ?? null,
    [conversationSeed, pushed],
  );

  // Socket updates received during the read win over the snapshot. Keep
  // telemetry that a Run frame doesn't carry and count each Run only once.
  const display = useMemo(() => {
    const seed = traceSeed?.traces ?? null;
    if (tab !== "traces" || seed === null) return { traces: null, summary: summarySeed, total };
    const rows = new Map(seed.map((trace) => [trace.trace_id, trace]));
    const added: TraceRow[] = [];
    let summary = summarySeed;
    for (const run of pushed?.runs?.values() ?? []) {
      const before = rows.get(run.id);
      if (before === undefined && !runMatchesFilters(run, filters, agentId)) continue;
      const after = before === undefined ? traceFromRun(run) : traceWithRun(before, run);
      if (before === undefined) added.push(after);
      else rows.set(run.id, after);
      if (summary !== null) summary = summaryWithTrace(summary, before, after);
    }
    return {
      traces: [...added.reverse(), ...rows.values()],
      summary,
      total: (traceSeed?.total ?? 0) + added.length,
    };
  }, [tab, traceSeed, pushed, summarySeed, total, filters, agentId]);

  useEffect(() => {
    let live = true;
    setError(null);
    // On connect a Run may arrive before React starts the new HTTP read.
    setUpdates((current) => (current?.scope === scope && current.epoch === seedEpoch ? current : null));
    // The window ends now: computed per fetch, not per render.
    const range = windowQuery(period);
    const query: ActivityQuery = {
      ...range,
      ...(agentId !== undefined ? { agent: agentId } : {}),
      ...(q !== "" ? { q } : {}),
    };
    void getActivitySummary({
      ...range,
      ...(agentId !== undefined ? { agent: agentId } : {}),
    })
      .then((value) => {
        if (live) setSummary(value);
      })
      .catch(() => {
        if (live) setSummary(null);
      });
    const load =
      tab === "calls"
        ? listSpans({
            ...query,
            type: "llm",
            ...(caller !== "all" ? { caller: caller as "model" | "judge" } : {}),
            ...(model !== "" ? { model } : {}),
          }).then((res) => {
            if (!live) return;
            setSpans(res.spans);
            setTotal(res.total);
          })
        : tab === "chats"
          ? listConversations({ ...query, ...(background ? { background } : {}) }).then((res) => {
              if (!live) return;
              setConversations(res.conversations);
              setTotal(res.total);
            })
          : listTraces({
              ...query,
              ...(status !== "all" ? { status } : {}),
              ...(trigger !== "all" ? { trigger } : {}),
            }).then((res) => {
              if (!live) return;
              setTraceSeed(res);
            });
    void load.catch((err: unknown) => {
      if (!live) return;
      setError(err instanceof Error ? err.message : "The activity API did not answer.");
      setTraceSeed(null);
      setSpans(null);
      setConversations(null);
    });
    return () => {
      live = false;
    };
  }, [tab, period, status, trigger, q, caller, model, agentId, background, tick, scope, seedEpoch]);

  useActivityRunUpdates(({ run, counts }, epoch) => {
    const threadId = run.thread_id;
    if (tab === "chats" && counts !== null && threadId !== null && (!run.internal || background)) {
      setUpdates((current) => {
        const previous = current?.scope === scope && current.epoch === epoch ? current.counts : undefined;
        return { scope, epoch, counts: { ...previous, [threadId]: counts } };
      });
    }
    if (tab === "traces" && (!run.internal || admin) && (agentId === undefined || run.agent_id === agentId)) {
      setUpdates((current) => {
        const previous = current?.scope === scope && current.epoch === epoch ? current.runs : undefined;
        return { scope, epoch, runs: new Map(previous).set(run.id, run) };
      });
    }
  });

  const body = (
    <>
      <SummaryCards summary={display.summary} admin={admin} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={filters.period} onValueChange={(v) => set({ period: v as ActivityPeriod })}>
          <SelectTrigger aria-label="Period" className="h-8 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                Last {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filters.tab === "traces" && (
          <>
            <Select value={filters.status} onValueChange={(v) => set({ status: v })}>
              <SelectTrigger aria-label="Filter by status" className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RUN_STATUS_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.trigger} onValueChange={(v) => set({ trigger: v })}>
              <SelectTrigger aria-label="Filter by trigger" className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All triggers</SelectItem>
                {TRIGGERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RUN_TRIGGER_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {filters.tab === "calls" && (
          <>
            <div className="flex items-center gap-1">
              {(["all", "model", "judge"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => set({ caller: value })}
                  className={`rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                    filters.caller === value
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent/50 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
            <input
              value={filters.model}
              onChange={(e) => set({ model: e.target.value }, { replace: true })}
              placeholder="model filter"
              className="w-40 rounded-md border border-border bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground/60"
            />
          </>
        )}
        <div className="relative min-w-32 max-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filters.q}
            onChange={(e) => set({ q: e.target.value }, { replace: true })}
            placeholder={
              filters.tab === "chats"
                ? "Search title, owner or agent"
                : filters.tab === "traces"
                  ? "Search summary or agent"
                  : "Search"
            }
            className="w-full rounded-md border border-border bg-transparent py-1 pl-7 pr-2 text-xs placeholder:text-muted-foreground/60"
          />
        </div>
        {admin && tab === "chats" && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={background}
              onChange={(event) => set({ background: event.target.checked })}
            />
            Include background threads
          </label>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {count(display.total, filters.tab === "chats" ? "thread" : filters.tab === "calls" ? "call" : "run")}
          </span>
          {filters.tab !== "traces" && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Refresh activity"
              onClick={() => setTick((value) => value + 1)}
            >
              <RefreshCw />
              Refresh
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3">
        {error !== null && (
          <ErrorState title="Could not load activity" message={error} onRetry={() => setTick((t) => t + 1)} />
        )}
        {error === null && filters.tab === "traces" && (
          <TracesTable
            rows={display.traces}
            admin={admin}
            showAgent={agentId === undefined}
            onOpen={(id) => onNavigate({ view: "run", runId: id })}
          />
        )}
        {error === null && filters.tab === "calls" && (
          <CallsTable
            rows={spans}
            admin={admin}
            onOpen={(span) => {
              if (span.run_id !== null) onNavigate({ view: "run", runId: span.run_id });
              else if (span.trace_id !== "") onNavigate({ view: "trace", traceId: span.trace_id });
              else if (span.chat_id !== null && onOpenChat !== undefined) onOpenChat(span.chat_id);
            }}
          />
        )}
        {error === null && filters.tab === "chats" && (
          <ConversationsTable
            rows={conversations}
            admin={admin}
            showOwner={role === "admin"}
            onOpen={(id) => onNavigate({ view: "chat", chatId: id })}
          />
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div>
        <div className="mb-3">
          <TabBar label="Activity views" tabs={ACTIVITY_TABS} value={filters.tab} onChange={(tab) => set({ tab })} />
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        variant="bar"
        title="Activity"
        tabs={
          <TabBar label="Activity views" tabs={ACTIVITY_TABS} value={filters.tab} onChange={(tab) => set({ tab })} />
        }
      />
      <PageBody className="max-w-[76rem]">{body}</PageBody>
    </div>
  );
}

function SummaryCards({ summary, admin }: { summary: ActivitySummary | null; admin: boolean }) {
  const totals = summary?.totals;
  const cards = [
    {
      label: "Runs",
      value: totals === undefined ? null : compact(totals.traces),
      icon: <Activity className="size-3.5" />,
    },
    {
      label: "Model calls",
      value: totals === undefined ? null : compact(totals.calls),
      icon: <MessageSquare className="size-3.5" />,
    },
    {
      label: "Tokens",
      value: totals === undefined ? null : compact(totals.tokens_in + totals.tokens_out),
      icon: <Coins className="size-3.5" />,
    },
    ...(admin
      ? [
          {
            label: "Cost",
            value: totals === undefined ? null : money(totals.cost_usd),
            icon: <Coins className="size-3.5" />,
          },
        ]
      : []),
    {
      label: "Errors",
      value: totals === undefined ? null : compact(totals.errors + totals.failed_traces),
      icon: <AlertTriangle className="size-3.5" />,
    },
    {
      label: "p95 latency",
      value: totals === undefined ? null : ms(totals.p95_ms),
      icon: <Timer className="size-3.5" />,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-border bg-card p-3">
          <p className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {card.icon}
            {card.label}
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            {card.value ?? <span className="text-muted-foreground">—</span>}
          </p>
        </div>
      ))}
    </div>
  );
}

function TracesTable({
  rows,
  admin,
  showAgent,
  onOpen,
}: {
  rows: TraceRow[] | null;
  admin: boolean;
  showAgent: boolean;
  onOpen: (id: string) => void;
}) {
  if (rows === null) return <LoadingRows rows={6} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No runs yet"
        hint="A run appears when an agent turn starts. Silent runs are recorded too."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="hidden grid-cols-[minmax(0,1fr)_7rem_6rem_5rem_5rem_5rem_2rem] gap-3 border-b border-border px-3 py-2 text-2xs uppercase tracking-wide text-muted-foreground lg:grid">
        <span>Run</span>
        <span>Agent</span>
        <span>Status</span>
        <span className="text-right">Model calls</span>
        <span className="text-right">Tokens</span>
        <span className="text-right">Duration</span>
        <span />
      </div>
      {rows.map((row) => (
        <button
          key={row.trace_id}
          type="button"
          onClick={() => onOpen(row.trace_id)}
          className="grid w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50 lg:grid-cols-[minmax(0,1fr)_7rem_6rem_5rem_5rem_5rem_2rem]"
        >
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium">
                {row.summary.trim() !== "" ? row.summary : `${triggerLabel(row.trigger)} run`}
              </span>
              <span className="lg:hidden">
                <ToneBadge tone={toneOf(row.status)}>{statusLabel(row.status)}</ToneBadge>
              </span>
              {row.error_count > 0 && <ToneBadge tone="danger">{count(row.error_count, "error")}</ToneBadge>}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{time(row.started_at)}</span>
              <span>·</span>
              <span>{triggerLabel(row.trigger)}</span>
              <span>·</span>
              <span>{count(row.call_count, "call")}</span>
              <span>·</span>
              <span>{count(row.tool_count, "tool")}</span>
              {showAgent && row.agent_name !== "" && (
                <>
                  <span className="lg:hidden">·</span>
                  <span className="lg:hidden">{row.agent_name}</span>
                </>
              )}
              <span className="lg:hidden">·</span>
              <span className="lg:hidden">{ms(row.duration_ms)}</span>
              {admin && (
                <>
                  <span>·</span>
                  <span>{money(row.cost_usd)}</span>
                </>
              )}
            </span>
          </span>
          <span className="hidden min-w-0 items-center gap-1.5 lg:flex">
            {showAgent && row.agent_name !== "" ? (
              <>
                <AgentGlyph name={row.agent_name} className="size-6 rounded text-3xs" />
                <span className="truncate text-xs">{row.agent_name}</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </span>
          <span className="hidden lg:block">
            <ToneBadge tone={toneOf(row.status)}>{statusLabel(row.status)}</ToneBadge>
          </span>
          <span className="hidden text-right text-xs tabular-nums lg:block">{row.call_count}</span>
          <span className="hidden text-right text-xs tabular-nums lg:block">{compact(totalTokens(row))}</span>
          <span className="hidden text-right text-xs tabular-nums lg:block">{ms(row.duration_ms)}</span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function CallsTable({
  rows,
  admin,
  onOpen,
}: {
  rows: SpanRow[] | null;
  admin: boolean;
  onOpen: (span: SpanRow) => void;
}) {
  if (rows === null) return <LoadingRows rows={6} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No model calls in this window"
        hint="Model calls are recorded on every gateway model request and approval judge verdict."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="hidden grid-cols-[9rem_11rem_minmax(0,1fr)_6rem_5rem_5rem_5rem_2rem] gap-3 border-b border-border px-3 py-2 text-2xs uppercase tracking-wide text-muted-foreground lg:grid">
        <span>Time</span>
        <span>Model</span>
        <span>Run</span>
        <span>Caller</span>
        <span className="text-right">Tokens</span>
        <span className="text-right">Latency</span>
        <span className="text-right">Cost</span>
        <span />
      </div>
      {rows.map((span) => (
        <button
          key={span.span_id}
          type="button"
          onClick={() => onOpen(span)}
          className="grid w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50 lg:grid-cols-[9rem_11rem_minmax(0,1fr)_6rem_5rem_5rem_5rem_2rem]"
        >
          <span className="min-w-0 lg:hidden">
            <span className="flex items-center gap-1.5">
              <span
                className={`size-1.5 shrink-0 rounded-full ${span.status === "error" ? "bg-destructive" : "bg-emerald-500"}`}
              />
              <span className="truncate font-mono text-xs">{span.model || span.name}</span>
              <ToneBadge tone={span.caller === "judge" ? "info" : "neutral"}>{span.caller || "model"}</ToneBadge>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{time(span.start_time)}</span>
              <span>·</span>
              <span className="truncate">
                {span.run_id !== null
                  ? `run ${span.run_id.slice(0, 8)}`
                  : span.chat_id !== null
                    ? `chat ${span.chat_id.slice(0, 8)}`
                    : "—"}
              </span>
              <span>·</span>
              <span className="tabular-nums">
                {compact(span.tokens_in)}→{compact(span.tokens_out)} tok
              </span>
              <span>·</span>
              <span className="tabular-nums">{ms(span.duration_ms)}</span>
              {admin && (
                <>
                  <span>·</span>
                  <span className="tabular-nums">{money(span.cost_usd)}</span>
                </>
              )}
            </span>
          </span>
          <span className="hidden text-xs text-muted-foreground lg:block">{time(span.start_time)}</span>
          <span className="hidden truncate font-mono text-xs lg:block">{span.model || span.name}</span>
          <span className="hidden min-w-0 lg:block">
            <span className="flex items-center gap-1.5">
              <span
                className={`size-1.5 shrink-0 rounded-full ${span.status === "error" ? "bg-destructive" : "bg-emerald-500"}`}
              />
              <span className="truncate text-xs text-muted-foreground">
                {span.run_id !== null
                  ? `run ${span.run_id.slice(0, 8)}`
                  : span.chat_id !== null
                    ? `chat ${span.chat_id.slice(0, 8)}`
                    : "—"}
              </span>
            </span>
          </span>
          <span className="hidden lg:block">
            <ToneBadge tone={span.caller === "judge" ? "info" : "neutral"}>{span.caller || "model"}</ToneBadge>
          </span>
          <span className="hidden text-right text-xs tabular-nums lg:block">
            {compact(span.tokens_in)}→{compact(span.tokens_out)}
          </span>
          <span className="hidden text-right text-xs tabular-nums lg:block">{ms(span.duration_ms)}</span>
          <span className="hidden text-right text-xs tabular-nums lg:block">{admin ? money(span.cost_usd) : "—"}</span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function ConversationsTable({
  rows,
  admin,
  showOwner,
  onOpen,
}: {
  rows: ConversationRow[] | null;
  admin: boolean;
  showOwner: boolean;
  onOpen: (id: string) => void;
}) {
  if (rows === null) return <LoadingRows rows={6} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No threads in this window"
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="hidden grid-cols-[minmax(0,1fr)_9rem_8rem_4rem_5rem_5rem_7rem_2rem] gap-3 border-b border-border px-3 py-2 text-2xs uppercase tracking-wide text-muted-foreground lg:grid">
        <span>Thread</span>
        <span>Owner</span>
        <span>Agent</span>
        <span className="text-right">Runs</span>
        <span className="text-right">Tokens</span>
        <span className="text-right">Cost</span>
        <span className="text-right">Last activity</span>
        <span />
      </div>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onOpen(row.id)}
          className="grid w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50 lg:grid-cols-[minmax(0,1fr)_9rem_8rem_4rem_5rem_5rem_7rem_2rem]"
        >
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium">
                {row.title !== null && row.title.trim() !== "" ? row.title : "Untitled thread"}
              </span>
              {row.internal && <ToneBadge tone="neutral">Background</ToneBadge>}
              {row.open_runs > 0 && <ToneBadge tone="info">Running</ToneBadge>}
              {row.failed_runs > 0 && <ToneBadge tone="danger">{count(row.failed_runs, "failed run")}</ToneBadge>}
              {row.archived && <ToneBadge tone="neutral">Archived</ToneBadge>}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{count(row.messages, "message")}</span>
              <span>·</span>
              <span>{count(row.runs, "run")}</span>
              <span>·</span>
              <span>{compact(row.tokens_in + row.tokens_out)} tokens</span>
              <span>·</span>
              <span>{time(row.last_activity_at)}</span>
              {showOwner && (
                <>
                  <span className="lg:hidden">·</span>
                  <span className="lg:hidden">{ownerName(row)}</span>
                </>
              )}
              {admin && (
                <>
                  <span>·</span>
                  <span>{money(row.cost_usd)}</span>
                </>
              )}
            </span>
          </span>
          <span className="hidden min-w-0 lg:block">
            {showOwner ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-3xs font-semibold uppercase">
                  {ownerInitials(row)}
                </span>
                <span className="truncate text-xs">{ownerName(row)}</span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </span>
          <span className="hidden min-w-0 lg:block">
            {row.agent !== null ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <AgentGlyph name={row.agent.name} className="size-6 rounded text-3xs" />
                <span className="truncate text-xs">{row.agent.name}</span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </span>
          <span className="hidden text-right text-xs tabular-nums lg:block">{row.runs}</span>
          <span className="hidden text-right text-xs tabular-nums lg:block">
            {compact(row.tokens_in + row.tokens_out)}
          </span>
          <span className="hidden text-right text-xs tabular-nums lg:block">{admin ? money(row.cost_usd) : "—"}</span>
          <span className="hidden text-right text-xs tabular-nums text-muted-foreground lg:block">
            {time(row.last_activity_at)}
          </span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

/** A one-line gist of a run summary: markdown markers and line breaks out,
 *  then a hard cut. The full reply renders below the run row. */
function plainPreview(text: string): string {
  const plain = text
    .replace(/[#*_`>\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 180 ? `${plain.slice(0, 180)}…` : plain;
}

function ownerName(row: ConversationRow): string {
  return row.owner.display_name !== null && row.owner.display_name !== "" ? row.owner.display_name : row.owner.email;
}

function ownerInitials(row: ConversationRow): string {
  const name = ownerName(row).trim();
  if (name === "") return "?";
  const parts = name.split(/\s+/);
  return parts.length === 1 ? name.slice(0, 2) : `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`;
}

function conversationItemKey(item: ConversationItem): string {
  return item.kind === "message" ? `message:${item.seq}` : `run:${item.run.id}`;
}

function mergeConversationPage(
  current: ConversationSnapshot | null,
  newest: ConversationSnapshot,
): ConversationSnapshot {
  if (current === null || !newest.has_more || newest.items.length === 0) return newest;
  const newestKeys = new Set(newest.items.map(conversationItemKey));
  // A reconnect can miss a whole page. Without an overlap between the two
  // pages, use the new cursor so paging can fill the gap.
  if (!current.items.some((item) => item.kind === "message" && newestKeys.has(conversationItemKey(item)))) {
    return newest;
  }
  const first = Date.parse(newest.items[0]!.ts);
  const older = current.items.filter(
    (item) => Date.parse(item.ts) <= first && !newestKeys.has(conversationItemKey(item)),
  );
  return older.length === 0
    ? newest
    : {
        ...newest,
        items: [...older, ...newest.items],
        has_more: current.has_more,
      };
}

export function ConversationPage({
  chatId,
  role,
  onNavigate,
  onOpenChat,
  onResync,
}: {
  chatId: string;
  /** The signed-in user's workspace role. */
  role: string;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
  onResync?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ detail: ConversationSnapshot | null; socket: boolean } | null>(null);
  const [analytics, setAnalytics] = useState<ConversationDetail | null>(null);
  const [liveCallCounts, setLiveCallCounts] = useState<Record<string, { call_count?: number; tool_count?: number }>>(
    {},
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const detail = snapshot?.detail ?? null;
  const unavailable = snapshot?.socket === true && detail === null;
  const unavailableRef = useRef(false);
  const loadError = unavailable ? "This conversation is unavailable." : error;
  const refresh = () => {
    onResync?.();
    setTick((current) => current + 1);
  };

  useActivityRunUpdates(({ run }) => {
    if (run.thread_id === null || run.thread_id !== detail?.conversation.thread?.id) return;
    if (run.call_count === undefined && run.tool_count === undefined) return;
    setLiveCallCounts((current) => ({
      ...current,
      [run.id]: {
        ...current[run.id],
        ...(run.call_count === undefined ? {} : { call_count: run.call_count }),
        ...(run.tool_count === undefined ? {} : { tool_count: run.tool_count }),
      },
    }));
  });

  useActivityConversationUpdates(({ chat_id: watchedId, detail: page }) => {
    if (watchedId !== chatId) return;
    unavailableRef.current = page === null;
    if (page === null) {
      setAnalytics(null);
      setLiveCallCounts({});
    }
    setSnapshot((current) => ({
      detail: page === null ? null : mergeConversationPage(current?.detail ?? null, page),
      socket: true,
    }));
    setError(null);
  });

  useEffect(() => {
    let live = true;
    setError(null);
    void getConversation(chatId, { limit: ACTIVITY_CONVERSATION_PAGE })
      .then((value) => {
        if (!live || unavailableRef.current) return;
        setAnalytics(value);
        setSnapshot((current) =>
          current?.socket === true
            ? current
            : {
                detail: mergeConversationPage(current?.detail ?? null, value),
                socket: false,
              },
        );
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "The conversation did not load.");
      });
    return () => {
      live = false;
    };
  }, [chatId, tick]);

  const loadOlder = () => {
    const oldestSeq = detail?.items.reduce<number | null>((min, item) => {
      if (item.kind !== "message") return min;
      return min === null ? item.seq : Math.min(min, item.seq);
    }, null);
    if (oldestSeq == null || loadingOlder) return;
    setLoadingOlder(true);
    void getConversation(chatId, { before: oldestSeq, limit: ACTIVITY_CONVERSATION_PAGE })
      .then((value) => {
        if (unavailableRef.current) return;
        setSnapshot((current) => {
          if (current?.detail == null) return current;
          const keys = new Set(current.detail.items.map(conversationItemKey));
          const older = value.items.filter((item) => !keys.has(conversationItemKey(item)));
          // If reconnect moved the cursor beyond the requested page, leave
          // the new page contiguous and allow an older-page read from it.
          if (!current.detail.items.some((item) => item.kind === "message" && item.seq === oldestSeq)) return current;
          return {
            ...current,
            detail: {
              ...current.detail,
              items: [...older, ...current.detail.items],
              has_more: value.has_more,
            },
          };
        });
        setAnalytics((current) =>
          current === null ? value : { ...current, items: [...value.items, ...current.items] },
        );
      })
      .catch(() => {
        // The page stays as it is, and the reader can retry.
      })
      .finally(() => setLoadingOlder(false));
  };

  const admin = role === "admin";
  const conversation =
    detail === null
      ? null
      : {
          ...detail.conversation,
          tokens_in: analytics?.conversation.tokens_in ?? 0,
          tokens_out: analytics?.conversation.tokens_out ?? 0,
          cost_usd: analytics?.conversation.cost_usd ?? 0,
          errors: analytics?.conversation.errors ?? 0,
        };
  const items = useMemo(() => {
    const measured = new Map(
      analytics?.items
        .filter((item): item is ConversationRunItem => item.kind === "run")
        .map((item) => [item.run.id, item]) ?? [],
    );
    return (detail?.items ?? []).map((item) => {
      if (item.kind !== "run") return item;
      const measuredCounts = measured.get(item.run.id);
      const live = liveCallCounts[item.run.id];
      const call_count = live?.call_count ?? measuredCounts?.call_count ?? item.call_count;
      const tool_count = live?.tool_count ?? measuredCounts?.tool_count ?? item.tool_count;
      return { ...item, steps: call_count + tool_count, call_count, tool_count };
    });
  }, [detail, analytics, liveCallCounts]);
  const totals = useMemo(() => {
    const runItems = items.filter((item): item is ConversationRunItem => item.kind === "run");
    return {
      runs: runItems.length,
      steps: runItems.reduce((sum, item) => sum + item.steps, 0),
      errors: runItems.filter((item) => item.run.status === "failed").length,
    };
  }, [items]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        variant="bar"
        title={
          conversation?.title !== null && conversation?.title !== undefined && conversation.title.trim() !== ""
            ? conversation.title
            : "Thread"
        }
        description={
          conversation !== null
            ? `${ownerName(conversation)}${conversation.agent !== null ? ` · ${conversation.agent.name}` : ""}`
            : chatId
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onNavigate(
                  conversation?.internal
                    ? { ...AGENTS_ACTIVITY, filters: { ...AGENTS_ACTIVITY.filters, background: true } }
                    : AGENTS_ACTIVITY,
                )
              }
            >
              <ArrowLeft />
              Activity
            </Button>
            <Button variant="ghost" size="sm" aria-label="Refresh thread" onClick={refresh}>
              <RefreshCw />
              Refresh
            </Button>
            {conversation?.thread?.parent_chat_id != null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate({ view: "chat", chatId: conversation.thread!.parent_chat_id! })}
              >
                <CornerUpLeft />
                Parent thread
              </Button>
            )}
            {(detail?.related_threads?.length ?? 0) > 0 && (
              <Select value="" onValueChange={(id) => onNavigate({ view: "chat", chatId: id })}>
                <SelectTrigger aria-label="Related threads" className="h-8 w-40 text-xs">
                  <SelectValue placeholder="Related threads" />
                </SelectTrigger>
                <SelectContent>
                  {detail?.related_threads?.map((thread) => (
                    <SelectItem key={thread.id} value={thread.id}>
                      {thread.title?.trim() || "Untitled thread"}
                      {thread.internal ? " · Background" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {onOpenChat !== undefined && conversation !== null && !conversation.internal && (
              <Button variant="outline" size="sm" onClick={() => onOpenChat(chatId)}>
                <MessageSquare />
                Open chat
              </Button>
            )}
          </>
        }
      />
      <PageBody className="max-w-[80rem]">
        {loadError !== null && detail === null && <ErrorState message={loadError} onRetry={refresh} />}
        {loadError === null && detail === null && <InlineLoading label="Loading thread" />}
        {detail !== null && (
          <>
            <div className="rounded-xl border border-border bg-card p-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
                <div>
                  <dt className="text-muted-foreground">Runs</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{conversation?.runs ?? totals.runs}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Messages</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{conversation?.messages ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Steps</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{compact(totals.steps)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                    {compact((conversation?.tokens_in ?? 0) + (conversation?.tokens_out ?? 0))}
                  </dd>
                </div>
                {admin && (
                  <div>
                    <dt className="text-muted-foreground">Cost</dt>
                    <dd className="mt-0.5 text-lg font-semibold tabular-nums">{money(conversation?.cost_usd ?? 0)}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">Failed runs</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                    {conversation?.failed_runs ?? totals.errors}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="mt-4 space-y-3">
              {detail.has_more && (
                <div className="flex justify-center">
                  <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
                    {loadingOlder ? "Loading earlier…" : "Load earlier messages"}
                  </Button>
                </div>
              )}
              {items.length === 0 && (
                <EmptyState
                  icon={MessageSquare}
                  title="This conversation has no messages"
                  hint="A chat with no turns has nothing to read yet."
                />
              )}
              {items.map((item) =>
                item.kind === "run" ? (
                  <RunItem
                    key={`run-${item.run.id}`}
                    item={item}
                    admin={admin}
                    onOpen={() => onNavigate({ view: "run", runId: item.run.id })}
                  />
                ) : (
                  <MessageItem key={conversationItemKey(item)} item={item} />
                ),
              )}
            </div>
          </>
        )}
      </PageBody>
    </div>
  );
}

/** The run's summary row: it reads under the agent's reply and is the door
 *  into the run detail. The trigger is its own message item. */
function RunItem({ item, admin, onOpen }: { item: ConversationRunItem; admin: boolean; onOpen: () => void }) {
  const duration =
    item.run.finished_at === null
      ? null
      : Math.max(0, Date.parse(item.run.finished_at) - Date.parse(item.run.started_at));
  return (
    <div className="space-y-2">
      {item.trigger === null && (
        <p className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted-foreground">
          <Bot className="size-3.5" />
          {triggerLabel(item.run.trigger)} trigger
        </p>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/50"
      >
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
          <Bot className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <ToneBadge tone={toneOf(item.run.status)}>{statusLabel(item.run.status)}</ToneBadge>
            <span className="text-sm font-medium">
              {item.run.agent_name !== "" ? item.run.agent_name : "Agent"} run
            </span>
            <span className="text-xs text-muted-foreground">
              {count(item.steps, "step")}
              {duration !== null ? ` · ${ms(duration)}` : ""}
              {admin && item.run.tokens > 0 ? ` · ${compact(item.run.tokens)} tokens` : ""}
            </span>
          </span>
          {!item.reply && item.run.summary !== "" && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {plainPreview(item.run.summary)}
            </span>
          )}
          {item.run.error_message !== "" && (
            <span className="mt-0.5 block truncate text-xs text-destructive">{item.run.error_message}</span>
          )}
        </span>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

function MessageItem({ item }: { item: Extract<ConversationItem, { kind: "message" }> }) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl border border-border bg-accent/40 px-3 py-2">
          <p className="flex items-center justify-end gap-1.5 text-2xs text-muted-foreground">
            <User className="size-3" />
            {time(item.ts)}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{item.text}</p>
        </div>
      </div>
    );
  }
  if (item.role === "assistant") {
    return (
      <div className="max-w-[85%]">
        <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <Bot className="size-3" />
          {time(item.ts)}
        </p>
        <div className={cn("mt-1 text-sm text-foreground", MD_CLASS, MD_TABLE_CLASS)}>
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {item.text}
          </Markdown>
        </div>
      </div>
    );
  }
  if (item.role === "error") {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs text-destructive">
        {item.text}
      </p>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-2xs uppercase tracking-wide text-muted-foreground">
        {item.role === "compaction" ? "Compaction summary" : "System"} · {time(item.ts)}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.text}</p>
    </div>
  );
}

export { RunDetailPage } from "./TraceDetail";

export { agentsRoutePath };
