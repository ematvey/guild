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
  Bot,
  ChevronRight,
  Coins,
  FileText,
  MessageSquare,
  RefreshCw,
  Search,
  Timer,
  Wrench,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { apiMe } from "../../transport";
import { relativeTime } from "../../lib/relative-time";
import {
  RUN_STATUS_LABEL,
  RUN_TRIGGER_LABEL,
  agentsRoutePath,
  type AgentsRoute,
} from "./agents-route";
import {
  getActivitySummary,
  getSpanPayloads,
  getTrace,
  listRunArtifacts,
  listSessions,
  listSpans,
  listTraces,
  type ActivityPeriod,
  type ActivityQuery,
  type ActivitySummary,
  type ActivityTab,
  type AgentArtifact,
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
  Section,
  TabBar,
  ToneBadge,
} from "./agent-ui";

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

const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
const money = (v: number): string => `$${v.toFixed(4)}`;
const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const time = (iso: string | null): string =>
  iso === null
    ? "—"
    : new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
const totalTokens = (row: { tokens_in: number; tokens_out: number }): number =>
  row.tokens_in + row.tokens_out;
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function toneOf(status: string): "success" | "danger" | "info" | "warning" | "neutral" {
  if (status === "succeeded" || status === "ok") return "success";
  if (status === "failed" || status === "error") return "danger";
  if (status === "running") return "info";
  if (status === "queued") return "warning";
  return "neutral";
}

function statusLabel(status: string): string {
  if (status === "ok") return "ok";
  if (status === "error") return "error";
  return RUN_STATUS_LABEL[status as keyof typeof RUN_STATUS_LABEL] ?? status;
}

function triggerLabel(trigger: string): string {
  return RUN_TRIGGER_LABEL[trigger as keyof typeof RUN_TRIGGER_LABEL] ?? trigger;
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
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={state.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search summary or agent"
            className="w-40 rounded-md border border-border bg-transparent py-1 pl-7 pr-2 text-xs placeholder:text-muted-foreground/60 lg:w-56"
          />
        </div>
        <div className="flex-1" />
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
            onOpen={(id) => onOpenChat?.(id)}
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
      <div className="hidden grid-cols-[9rem_9rem_minmax(0,1fr)_6rem_5rem_5rem_5rem_2rem] gap-3 border-b border-border px-3 py-2 text-2xs uppercase tracking-wide text-muted-foreground lg:grid">
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
          className="grid w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50 lg:grid-cols-[9rem_9rem_minmax(0,1fr)_6rem_5rem_5rem_5rem_2rem]"
        >
          <span className="text-xs text-muted-foreground">{time(span.start_time)}</span>
          <span className="truncate font-mono text-xs">{span.model || span.name}</span>
          <span className="min-w-0">
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

export function RunDetailPage({
  runId,
  onNavigate,
  onOpenChat,
}: {
  runId: string;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
}) {
  const [trace, setTrace] = useState<TraceRow | null>(null);
  const [spans, setSpans] = useState<SpanRow[]>([]);
  const [children, setChildren] = useState<TraceRow[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [selected, setSelected] = useState<SpanRow | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    apiMe().then((user) => setRole(user?.role ?? "member")).catch(() => setRole("member"));
  }, []);

  useEffect(() => {
    let live = true;
    setError(null);
    void getTrace(runId)
      .then((value) => {
        if (!live) return;
        setTrace(value.trace);
        setSpans(value.spans);
        setChildren(value.children);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "The trace did not load.");
      });
    void listRunArtifacts(runId)
      .then((rows) => {
        if (live) setArtifacts(rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [runId, tick]);

  const ordered = useMemo(
    () => [...spans].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time)),
    [spans],
  );
  const bounds = useMemo(() => {
    const spanStarts = ordered.map((span) => Date.parse(span.start_time));
    const spanEnds = ordered.map((span) =>
      span.end_time === null ? Date.parse(span.start_time) + span.duration_ms : Date.parse(span.end_time),
    );
    const traceStart = trace?.started_at === null || trace?.started_at === undefined ? NaN : Date.parse(trace.started_at);
    const traceEnd = trace?.finished_at === null || trace?.finished_at === undefined ? NaN : Date.parse(trace.finished_at);
    const starts = Number.isFinite(traceStart) ? [...spanStarts, traceStart] : spanStarts;
    const ends = Number.isFinite(traceEnd) ? [...spanEnds, traceEnd] : spanEnds;
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    return { start, end: Math.max(...ends, start + 1) };
  }, [ordered, trace?.started_at, trace?.finished_at]);

  const admin = role === "admin";
  const chatId = trace?.session_id ?? null;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title="Trace"
        description={trace === null ? runId : `${trace.agent_name || "Agent"} · ${triggerLabel(trace.trigger)} · ${time(trace.started_at)}`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ view: "activity" })}>
              <ArrowLeft />
              Activity
            </Button>
            {chatId !== null && onOpenChat !== undefined && (
              <Button variant="outline" size="sm" onClick={() => onOpenChat(chatId)}>
                <MessageSquare />
                Open chat
              </Button>
            )}
          </>
        }
      />
      <PageBody className="max-w-[80rem]">
        {error !== null && <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />}
        {error === null && trace === null && <InlineLoading label="Loading trace" />}
        {trace !== null && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <ToneBadge tone={toneOf(trace.status)}>{statusLabel(trace.status)}</ToneBadge>
              <ToneBadge tone="neutral">{triggerLabel(trace.trigger)}</ToneBadge>
              {trace.routine_id !== null && <ToneBadge tone="info">routine</ToneBadge>}
              <span className="text-xs text-muted-foreground">
                {count(trace.call_count, "call")} · {count(trace.tool_count, "tool")} · {compact(totalTokens(trace))} tokens
                {admin ? ` · ${money(trace.cost_usd)}` : ""}
              </span>
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground">{trace.started_at === null ? "—" : relativeTime(trace.started_at)}</span>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-sm font-medium">
                {trace.summary.trim() !== "" ? trace.summary : "No summary was recorded."}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{time(trace.started_at)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd>{time(trace.finished_at)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd>{ms(trace.duration_ms)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd>
                    {compact(trace.tokens_in)} in / {compact(trace.tokens_out)} out
                    {trace.reasoning_tokens > 0 ? ` / ${compact(trace.reasoning_tokens)} reasoning` : ""}
                  </dd>
                </div>
              </dl>
              {trace.error.trim() !== "" && (
                <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {trace.error}
                </p>
              )}
            </div>

            {bounds !== null && (
              <Section title="Timeline" description="Span bars on the trace's time axis.">
                <div className="space-y-1">
                  {ordered.map((span) => {
                    const left = ((Date.parse(span.start_time) - bounds.start) / (bounds.end - bounds.start)) * 100;
                    const width = Math.max(0.5, (span.duration_ms / (bounds.end - bounds.start)) * 100);
                    return (
                      <button
                        key={span.span_id}
                        type="button"
                        onClick={() => setSelected(span)}
                        className={`grid w-full grid-cols-[10rem_minmax(0,1fr)_5rem] items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/50 ${
                          selected?.span_id === span.span_id ? "bg-accent/60" : ""
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-1.5 text-xs">
                          {span.span_type === "llm" ? (
                            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{span.name}</span>
                        </span>
                        <span className="relative h-4 rounded bg-accent/40">
                          <span
                            className={`absolute top-0 h-4 rounded ${
                              span.status === "error"
                                ? "bg-destructive/70"
                                : span.span_type === "llm"
                                  ? "bg-sky-500/70"
                                  : "bg-emerald-500/70"
                            }`}
                            style={{
                              left: `${Math.min(99.5, Math.max(0, left))}%`,
                              width: `${Math.min(100 - Math.max(0, left), Math.max(0.5, width))}%`,
                            }}
                          />
                        </span>
                        <span className="text-right text-2xs tabular-nums text-muted-foreground">
                          {ms(span.duration_ms)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Section>
            )}

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <Section title="Transcript" description="Model turns and tool calls in order.">
                {ordered.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No spans were recorded for this trace.</p>
                ) : (
                  <ol className="space-y-1.5">
                    {ordered.map((span, index) => (
                      <li key={span.span_id}>
                        <button
                          type="button"
                          onClick={() => setSelected(span)}
                          className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50 ${
                            selected?.span_id === span.span_id ? "border-foreground/30 bg-muted/40" : "border-border"
                          }`}
                        >
                          <span className="mt-0.5 font-mono text-2xs text-muted-foreground">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="mt-0.5 shrink-0 text-muted-foreground">
                            {span.span_type === "llm" ? <Bot className="size-3.5" /> : <Wrench className="size-3.5" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">{span.name}</span>
                              {span.model !== "" && (
                                <span className="font-mono text-2xs text-muted-foreground">{span.model}</span>
                              )}
                              {span.status === "error" && <ToneBadge tone="danger">error</ToneBadge>}
                            </span>
                            <span className="mt-0.5 block truncate text-muted-foreground">
                              {spanPreview(span)}
                            </span>
                          </span>
                          <span className="shrink-0 text-right text-2xs text-muted-foreground">
                            {span.tokens_in + span.tokens_out > 0 && (
                              <span className="block tabular-nums">{compact(totalTokens(span))} tok</span>
                            )}
                            <span className="block tabular-nums">{ms(span.duration_ms)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>

              <div className="space-y-4">
                <Section title="Span detail">
                  {selected === null ? (
                    <p className="text-sm text-muted-foreground">Select a span to see its input, output and attributes.</p>
                  ) : (
                    <SpanDetail span={selected} admin={admin} />
                  )}
                </Section>

                <Section title="Metadata">
                  <dl className="space-y-2 text-xs">
                    <Meta label="Trace id" value={trace.trace_id} mono />
                    <Meta label="Agent" value={trace.agent_name || "—"} />
                    <Meta label="Session" value={trace.session_id ?? "—"} mono />
                    {trace.parent_trace_id !== null && (
                      <Meta label="Parent trace" value={trace.parent_trace_id} mono />
                    )}
                    <Meta label="Trigger" value={triggerLabel(trace.trigger)} />
                  </dl>
                </Section>
              </div>
            </div>

            {children.length > 0 && (
              <Section title="Delegated traces" description="Child runs this trace spawned.">
                <ul className="space-y-1.5">
                  {children.map((child) => (
                    <li key={child.trace_id}>
                      <button
                        type="button"
                        onClick={() => onNavigate({ view: "run", runId: child.trace_id })}
                        className="flex w-full items-start gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                      >
                        <span className="mt-0.5">
                          <ToneBadge tone={toneOf(child.status)}>{statusLabel(child.status)}</ToneBadge>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{child.agent_name || "Delegated agent"}</span>
                          {child.summary !== "" && (
                            <span className="mt-0.5 block truncate text-muted-foreground">{child.summary}</span>
                          )}
                        </span>
                        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {artifacts.length > 0 && (
              <Section title="Artifacts" description="Files the run returned.">
                <ul className="space-y-1">
                  {artifacts.map((artifact) => (
                    <li key={artifact.id} className="flex items-center gap-2 text-xs">
                      <FileText className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 break-all font-mono">{artifact.path}</span>
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {artifact.status} · {formatBytes(artifact.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        )}
      </PageBody>
    </div>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function spanPreview(span: SpanRow): string {
  const source = span.span_type === "llm" ? span.output : span.input;
  const text = source.replace(/\s+/g, " ").trim();
  return text === "" ? span.error || "—" : text.slice(0, 180);
}

function SpanDetail({ span, admin }: { span: SpanRow; admin: boolean }) {
  const [payloads, setPayloads] = useState<{ kind: string; body: string }[] | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);

  useEffect(() => {
    setPayloads(null);
    setPayloadError(null);
    if (!admin || span.span_type !== "llm") return;
    let live = true;
    void getSpanPayloads(span.span_id)
      .then((rows) => {
        if (live) setPayloads(rows);
      })
      .catch((err: unknown) => {
        if (live) setPayloadError(err instanceof Error ? err.message : "Payloads did not load.");
      });
    return () => {
      live = false;
    };
  }, [span.span_id, span.span_type, admin]);

  return (
    <div className="space-y-3 text-xs">
      <dl className="grid grid-cols-2 gap-2">
        <Meta label="Type" value={span.span_type} />
        <Meta label="Status" value={span.status} />
        <Meta label="Duration" value={ms(span.duration_ms)} />
        <Meta label="Caller" value={span.caller || "—"} />
        {span.model !== "" && <Meta label="Model" value={span.model} mono />}
        <Meta label="Tokens" value={`${span.tokens_in} in / ${span.tokens_out} out`} />
        {admin && <Meta label="Cost" value={money(span.cost_usd)} />}
        <Meta label="Span id" value={span.span_id} mono />
      </dl>
      {span.error !== "" && (
        <div>
          <p className="mb-1 text-muted-foreground">Error</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-destructive/5 p-2 font-mono text-2xs text-destructive">
            {span.error}
          </pre>
        </div>
      )}
      {span.input !== "" && <Block label="Input" body={span.input} />}
      {span.output !== "" && <Block label="Output" body={span.output} />}
      {Object.keys(span.attributes).length > 0 && (
        <Block label="Attributes" body={JSON.stringify(span.attributes, null, 2)} />
      )}
      {admin && span.span_type === "llm" && (
        <div>
          <p className="mb-1 text-muted-foreground">
            Payloads {payloads !== null && payloads.length === 0 ? "(none stored — payload tracing is off)" : ""}
          </p>
          {payloadError !== null && <p className="text-destructive">{payloadError}</p>}
          {payloads === null && payloadError === null ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            (payloads ?? []).map((payload) => (
              <div key={payload.kind} className="mb-2">
                <p className="mb-1 capitalize text-2xs text-muted-foreground">{payload.kind}</p>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-accent/50 p-2 font-mono text-2xs">
                  {payload.body}
                </pre>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <p className="mb-1 text-muted-foreground">{label}</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-accent/50 p-2 font-mono text-2xs">
        {body}
      </pre>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Small link helper used by agent pages. */
export function activityRouteForAgent(agentId: string): AgentsRoute {
  return { view: "agent", agentId, tab: "activity" };
}

export { agentsRoutePath };
