// Activity: one observability surface for agent work. Traces are agent
// runs (one per turn), spans are the LLM calls and tool calls inside a
// trace, sessions group traces by chat. The list and the trace detail read
// the same ClickHouse model the gateway and the tool hook write, so a run
// and its calls are one story. Navigation stays in the URL: the tab,
// period and filters ride the query, the open trace is /runs/<id>.

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Coins,
  MessageSquare,
  RefreshCw,
  Search,
  Timer,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { apiMe } from "../../lib/api/workspaces";
import {
  RUN_STATUS_LABEL,
  RUN_TRIGGER_LABEL,
  agentsRoutePath,
  type AgentsRoute,
} from "./agents-route";
import {
  getActivitySummary,
  listSessions,
  listSpans,
  listTraces,
  type ActivityPeriod,
  type ActivityQuery,
  type ActivitySummary,
  type ActivityTab,
  type SessionRow,
  type SpanRow,
  type TraceRow,
} from "./agents-api";
import {
  AgentGlyph,
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadingRows,
  PageBody,
  PageHeader,
  TabBar,
  ToneBadge,
} from "./agent-ui";
import { compact, count, money, ms, time, toneOf, totalTokens, triggerLabel, statusLabel } from "./activity-format";

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
  ["traces", "Traces"],
  ["calls", "Calls"],
  ["sessions", "Sessions"],
];
const STATUSES = ["queued", "running", "succeeded", "failed", "silent", "skipped"] as const;
const TRIGGERS = ["message", "routine", "manual", "delegation"] as const;
interface ListState {
  tab: ActivityTab;
  period: ActivityPeriod;
  status: string;
  trigger: string;
  q: string;
  caller: string;
  model: string;
}

const DEFAULTS: ListState = {
  tab: "traces",
  period: "7d",
  status: "all",
  trigger: "all",
  q: "",
  caller: "all",
  model: "",
};

function readListState(url: URL): ListState {
  const q = url.searchParams;
  const tab = q.get("tab");
  const period = q.get("period");
  return {
    tab: tab === "calls" || tab === "sessions" ? tab : DEFAULTS.tab,
    period: period === "24h" || period === "30d" ? period : DEFAULTS.period,
    status: q.get("status") ?? DEFAULTS.status,
    trigger: q.get("trigger") ?? DEFAULTS.trigger,
    q: q.get("q") ?? DEFAULTS.q,
    caller: q.get("caller") ?? DEFAULTS.caller,
    model: q.get("model") ?? DEFAULTS.model,
  };
}

function writeListState(state: ListState): void {
  const url = new URL(window.location.href);
  const params: Record<string, string> = {
    tab: state.tab,
    period: state.period,
    status: state.status,
    trigger: state.trigger,
    q: state.q,
    caller: state.caller,
    model: state.model,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || value === "all" || value === DEFAULTS[key as keyof ListState]) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  if (url.toString() !== window.location.href) window.history.pushState(null, "", url);
}

function windowQuery(period: ActivityPeriod): ActivityQuery {
  const now = Date.now();
  return {
    from: new Date(now - PERIOD_MS[period]).toISOString(),
    to: new Date(now + 60_000).toISOString(),
  };
}

export function ActivityPage({
  onNavigate,
  onOpenChat,
  agentId,
  embedded = false,
}: {
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
  /** Per-agent projection when set. */
  agentId?: string;
  embedded?: boolean;
}) {
  const [state, setState] = useState<ListState>(() => readListState(new URL(window.location.href)));
  const [role, setRole] = useState<string | null>(null);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [traces, setTraces] = useState<TraceRow[] | null>(null);
  const [spans, setSpans] = useState<SpanRow[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    apiMe().then((user) => setRole(user?.role ?? "member")).catch(() => setRole("member"));
  }, []);

  useEffect(() => {
    const onPop = () => setState(readListState(new URL(window.location.href)));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const set = (next: Partial<ListState>) => {
    const merged = { ...state, ...next };
    writeListState(merged);
    setState(merged);
  };

  const range = windowQuery(state.period);
  const filters: ActivityQuery = {
    ...range,
    ...(agentId !== undefined ? { agent: agentId } : {}),
    ...(state.q.trim() !== "" ? { q: state.q.trim() } : {}),
  };

  useEffect(() => {
    let live = true;
    setError(null);
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
      state.tab === "calls"
        ? listSpans({
            ...filters,
            type: "llm",
            ...(state.caller !== "all" ? { caller: state.caller as "model" | "judge" } : {}),
            ...(state.model !== "" ? { model: state.model } : {}),
          }).then((res) => {
            if (!live) return;
            setSpans(res.spans);
            setTotal(res.total);
          })
        : state.tab === "sessions"
          ? listSessions(filters).then((res) => {
              if (!live) return;
              setSessions(res.sessions);
              setTotal(res.total);
            })
          : listTraces({
              ...filters,
              ...(state.status !== "all" ? { status: state.status } : {}),
              ...(state.trigger !== "all" ? { trigger: state.trigger } : {}),
            }).then((res) => {
              if (!live) return;
              setTraces(res.traces);
              setTotal(res.total);
            });
    void load.catch((err: unknown) => {
      if (!live) return;
      setError(err instanceof Error ? err.message : "The activity API did not answer.");
      setTraces(null);
      setSpans(null);
      setSessions(null);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tab, state.period, state.status, state.trigger, state.q, state.caller, state.model, agentId, tick]);

  const admin = role === "admin";
  const body = (
    <>
      <SummaryCards summary={summary} admin={admin} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={state.period} onValueChange={(v) => set({ period: v as ActivityPeriod })}>
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
        {state.tab === "traces" && (
          <>
            <Select value={state.status} onValueChange={(v) => set({ status: v })}>
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
            <Select value={state.trigger} onValueChange={(v) => set({ trigger: v })}>
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
        {state.tab === "calls" && (
          <>
            <div className="flex items-center gap-1">
              {(["all", "model", "judge"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => set({ caller: value })}
                  className={`rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                    state.caller === value
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent/50 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
            <input
              value={state.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="model filter"
              className="w-40 rounded-md border border-border bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground/60"
            />
          </>
        )}
        <div className="relative min-w-32 max-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={state.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder={state.tab === "traces" ? "Search summary or agent" : "Search"}
            className="w-full rounded-md border border-border bg-transparent py-1 pl-7 pr-2 text-xs placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {count(total, state.tab === "sessions" ? "session" : state.tab === "calls" ? "call" : "trace")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh activity"
            onClick={() => setTick((value) => value + 1)}
          >
            <RefreshCw />
            Refresh
          </Button>
        </div>
      </div>

      <div className="mt-3">
        {error !== null && (
          <ErrorState title="Could not load activity" message={error} onRetry={() => setTick((t) => t + 1)} />
        )}
        {error === null && state.tab === "traces" && (
          <TracesTable
            rows={traces}
            admin={admin}
            showAgent={agentId === undefined}
            onOpen={(id) => onNavigate({ view: "run", runId: id })}
          />
        )}
        {error === null && state.tab === "calls" && (
          <CallsTable
            rows={spans}
            admin={admin}
            onOpen={(span) => {
              if (span.run_id !== null) onNavigate({ view: "run", runId: span.run_id });
              else if (span.chat_id !== null && onOpenChat !== undefined) onOpenChat(span.chat_id);
            }}
          />
        )}
        {error === null && state.tab === "sessions" && (
          <SessionsTable
            rows={sessions}
            admin={admin}
            onOpen={(id) => onNavigate({ view: "session", sessionId: id })}
          />
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div>
        <div className="mb-3">
          <TabBar
            label="Activity views"
            tabs={ACTIVITY_TABS}
            value={state.tab}
            onChange={(tab) => set({ tab })}
          />
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title="Activity"
        description="Agent runs, the LLM calls and tool calls inside them, and the chats they belong to."
        tabs={
          <TabBar
            label="Activity views"
            tabs={ACTIVITY_TABS}
            value={state.tab}
            onChange={(tab) => set({ tab })}
          />
        }
      />
      <PageBody className="max-w-[76rem]">{body}</PageBody>
    </div>
  );
}

function SummaryCards({ summary, admin }: { summary: ActivitySummary | null; admin: boolean }) {
  const totals = summary?.totals;
  const cards = [
    { label: "Traces", value: totals === undefined ? null : compact(totals.traces), icon: <Activity className="size-3.5" /> },
    { label: "Calls", value: totals === undefined ? null : compact(totals.calls), icon: <MessageSquare className="size-3.5" /> },
    {
      label: "Tokens",
      value: totals === undefined ? null : compact(totals.tokens_in + totals.tokens_out),
      icon: <Coins className="size-3.5" />,
    },
    ...(admin
      ? [{ label: "Cost", value: totals === undefined ? null : money(totals.cost_usd), icon: <Coins className="size-3.5" /> }]
      : []),
    {
      label: "Errors",
      value: totals === undefined ? null : compact(totals.errors + totals.failed_traces),
      icon: <AlertTriangle className="size-3.5" />,
    },
    { label: "p95 latency", value: totals === undefined ? null : ms(totals.p95_ms), icon: <Timer className="size-3.5" /> },
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
        icon={<Activity className="size-5" />}
        title="No traces yet"
        body="A trace appears when an agent run starts. Silent runs are recorded too."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="hidden grid-cols-[minmax(0,1fr)_7rem_6rem_5rem_5rem_5rem_2rem] gap-3 border-b border-border px-3 py-2 text-2xs uppercase tracking-wide text-muted-foreground lg:grid">
        <span>Trace</span>
        <span>Agent</span>
        <span>Status</span>
        <span className="text-right">Calls</span>
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
              {row.error_count > 0 && (
                <ToneBadge tone="danger">{count(row.error_count, "error")}</ToneBadge>
              )}
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
          <span className="hidden text-right text-xs tabular-nums lg:block">
            {compact(totalTokens(row))}
          </span>
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
        icon={<MessageSquare className="size-5" />}
        title="No calls in this window"
        body="Calls are recorded on every gateway model request and approval judge verdict."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="hidden grid-cols-[9rem_11rem_minmax(0,1fr)_6rem_5rem_5rem_5rem_2rem] gap-3 border-b border-border px-3 py-2 text-2xs uppercase tracking-wide text-muted-foreground lg:grid">
        <span>Time</span>
        <span>Model</span>
        <span>Trace</span>
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
              <span className={`size-1.5 shrink-0 rounded-full ${span.status === "error" ? "bg-destructive" : "bg-emerald-500"}`} />
              <span className="truncate font-mono text-xs">{span.model || span.name}</span>
              <ToneBadge tone={span.caller === "judge" ? "info" : "neutral"}>{span.caller || "model"}</ToneBadge>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{time(span.start_time)}</span>
              <span>·</span>
              <span className="truncate">
                {span.run_id !== null ? `run ${span.run_id.slice(0, 8)}` : span.chat_id !== null ? `chat ${span.chat_id.slice(0, 8)}` : "—"}
              </span>
              <span>·</span>
              <span className="tabular-nums">{compact(span.tokens_in)}→{compact(span.tokens_out)} tok</span>
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
              <span className={`size-1.5 shrink-0 rounded-full ${span.status === "error" ? "bg-destructive" : "bg-emerald-500"}`} />
              <span className="truncate text-xs text-muted-foreground">
                {span.run_id !== null ? `run ${span.run_id.slice(0, 8)}` : span.chat_id !== null ? `chat ${span.chat_id.slice(0, 8)}` : "—"}
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
          <span className="hidden text-right text-xs tabular-nums lg:block">
            {admin ? money(span.cost_usd) : "—"}
          </span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function SessionsTable({
  rows,
  admin,
  onOpen,
}: {
  rows: SessionRow[] | null;
  admin: boolean;
  onOpen: (id: string) => void;
}) {
  if (rows === null) return <LoadingRows rows={6} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquare className="size-5" />}
        title="No sessions in this window"
        body="A session is one chat: every trace and call inside it shares the chat id."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {rows.map((row) => (
        <button
          key={row.session_id}
          type="button"
          onClick={() => onOpen(row.session_id)}
          className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
            <MessageSquare className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">{row.session_id}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {count(row.traces, "trace")} · {count(row.calls, "call")} · {count(row.tool_calls, "tool")}
              {row.errors > 0 ? ` · ${count(row.errors, "error")}` : ""}
            </span>
          </span>
          <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:block">
            {compact(row.tokens_in + row.tokens_out)} tokens
          </span>
          {admin && (
            <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:block">
              {money(row.cost_usd)}
            </span>
          )}
          <span className="hidden text-right text-xs tabular-nums text-muted-foreground md:block">
            {ms(row.duration_ms)}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

export function SessionDetailPage({
  sessionId,
  onNavigate,
  onOpenChat,
}: {
  sessionId: string;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
}) {
  const [rows, setRows] = useState<TraceRow[] | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    apiMe().then((user) => setRole(user?.role ?? "member")).catch(() => setRole("member"));
  }, []);

  useEffect(() => {
    let live = true;
    setError(null);
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
    void listTraces({ session: sessionId, from, to, limit: 200 })
      .then((res) => {
        if (live) setRows(res.traces);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "The session did not load.");
        setRows(null);
      });
    return () => {
      live = false;
    };
  }, [sessionId, tick]);

  const admin = role === "admin";
  const totals = useMemo(() => {
    const list = rows ?? [];
    return {
      traces: list.length,
      calls: list.reduce((sum, row) => sum + row.call_count, 0),
      tools: list.reduce((sum, row) => sum + row.tool_count, 0),
      tokens: list.reduce((sum, row) => sum + totalTokens(row), 0),
      cost: list.reduce((sum, row) => sum + row.cost_usd, 0),
      duration: list.reduce((sum, row) => Math.max(sum, row.duration_ms), 0),
    };
  }, [rows]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title="Session"
        description={sessionId}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ view: "activity" })}>
              <ArrowLeft />
              Activity
            </Button>
            {onOpenChat !== undefined && (
              <Button variant="outline" size="sm" onClick={() => onOpenChat(sessionId)}>
                <MessageSquare />
                Open chat
              </Button>
            )}
          </>
        }
      />
      <PageBody className="max-w-[80rem]">
        {error !== null && <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />}
        {error === null && rows === null && <InlineLoading label="Loading session" />}
        {rows !== null && (
          <>
            <div className="rounded-xl border border-border bg-card p-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
                <div>
                  <dt className="text-muted-foreground">Traces</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{totals.traces}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Calls</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{totals.calls}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Tools</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{totals.tools}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{compact(totals.tokens)}</dd>
                </div>
                {admin && (
                  <div>
                    <dt className="text-muted-foreground">Cost</dt>
                    <dd className="mt-0.5 text-lg font-semibold tabular-nums">{money(totals.cost)}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">Longest</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{ms(totals.duration)}</dd>
                </div>
              </dl>
            </div>
            <div className="mt-4">
              <TracesTable
                rows={rows}
                admin={admin}
                showAgent
                onOpen={(id) => onNavigate({ view: "run", runId: id })}
              />
            </div>
          </>
        )}
      </PageBody>
    </div>
  );
}

export { RunDetailPage } from "./TraceDetail";

/** Small link helper used by agent pages. */
export function activityRouteForAgent(agentId: string): AgentsRoute {
  return { view: "agent", agentId, tab: "activity" };
}

export { agentsRoutePath };
