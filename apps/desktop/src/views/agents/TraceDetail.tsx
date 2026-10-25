// One trace, three readings of the same spans: the conversation transcript,
// the span tree and the time waterfall. The right pane is the selected span:
// overview, input, output and attributes, with readable JSON.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  MessageSquare,
  Wrench,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@guild/ui/components/button";
import { cn } from "@guild/ui/lib/utils";
import { apiMe } from "../../lib/api/servers";
import { relativeTime } from "../../lib/relative-time";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import {
  getRun,
  getSpanPayloads,
  getTrace,
  type AgentRun,
  type AgentRunStep,
  type SpanRow,
  type TraceRow,
} from "./agents-api";
import { AGENTS_ACTIVITY, type AgentsRoute } from "./agents-route";
import { compact, money, ms, spanPreview, statusLabel, time, toneOf, totalTokens, triggerLabel } from "./activity-format";
import { JsonView } from "./JsonView";
import { MessagesView, payloadMessages } from "./MessagesView";
import { ErrorState, InlineLoading, TabBar, ToneBadge } from "./agent-ui";

type TraceView = "transcript" | "tree" | "timeline";
const TRACE_VIEWS: ReadonlyArray<readonly [TraceView, string]> = [
  ["transcript", "Transcript"],
  ["tree", "Tree"],
  ["timeline", "Timeline"],
];

function readTraceView(): TraceView {
  const value = new URL(window.location.href).searchParams.get("view");
  return value === "tree" || value === "timeline" ? value : "transcript";
}

function writeTraceView(view: TraceView): void {
  const url = new URL(window.location.href);
  if (view === "transcript") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  if (url.toString() !== window.location.href) window.history.pushState(null, "", url);
}

export function RunDetailPage({
  runId,
  traceOnly = false,
  onNavigate,
  onOpenChat,
}: {
  runId: string;
  /** The route holds a trace id with no agent run behind it. */
  traceOnly?: boolean;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
}) {
  const [trace, setTrace] = useState<TraceRow | null>(null);
  const [spans, setSpans] = useState<SpanRow[]>([]);
  const [children, setChildren] = useState<TraceRow[]>([]);
  const [selected, setSelected] = useState<SpanRow | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [view, setView] = useState<TraceView>(readTraceView);
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
        setSelected((current) => {
          if (current !== null && value.spans.some((span) => span.span_id === current.span_id)) return current;
          const ordered = [...value.spans].sort(
            (a, b) => Date.parse(a.start_time) - Date.parse(b.start_time),
          );
          return ordered.find((span) => span.span_type === "llm") ?? ordered[0] ?? null;
        });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "The trace did not load.");
      });
    if (traceOnly) {
      setRun(null);
    } else {
      void getRun(runId)
        .then((value) => {
          if (live) setRun(value);
        })
        .catch(() => {
          if (live) setRun(null);
        });
    }
    return () => {
      live = false;
    };
  }, [runId, traceOnly, tick]);

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
  const title = trace === null ? runId : traceTitle(trace);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => onNavigate(AGENTS_ACTIVITY)}>
            <ArrowLeft />
            Activity
          </Button>
          {trace !== null && (
            <>
              <ToneBadge tone={toneOf(trace.status)}>{statusLabel(trace.status)}</ToneBadge>
              <ToneBadge tone="neutral">{triggerLabel(trace.trigger)}</ToneBadge>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {trace !== null && (
              <span className="text-2xs text-muted-foreground">
                {trace.started_at === null ? "—" : relativeTime(trace.started_at)}
              </span>
            )}
            {chatId !== null && onOpenChat !== undefined && (
              <Button variant="outline" size="sm" onClick={() => onOpenChat(chatId)}>
                <MessageSquare />
                Open chat
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h1 className="min-w-0 max-w-full truncate text-sm font-medium">{title}</h1>
          {trace !== null && (
            <span className="text-2xs text-muted-foreground">
              {trace.agent_name || "Agent"} · {time(trace.started_at)} · {ms(trace.duration_ms)} ·{" "}
              {compact(totalTokens(trace))} tokens
              {admin ? ` · ${money(trace.cost_usd)}` : ""}
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto xl:overflow-hidden">
        {error !== null && (
          <div className="mx-auto w-full max-w-[90rem] px-4 pt-4 sm:px-6">
            <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
          </div>
        )}
        {error === null && trace === null && spans.length === 0 && (
          <div className="mx-auto w-full max-w-[90rem] px-4 pt-4 sm:px-6">
            <InlineLoading label="Loading trace" />
          </div>
        )}
        {(trace !== null || spans.length > 0) && (
          <div className="flex min-h-full w-full flex-col gap-4 px-4 pb-16 pt-4 sm:px-6 xl:h-full xl:min-h-0 xl:flex-row xl:pb-4">
            <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card xl:min-h-0 xl:flex-1">
              <div className="shrink-0 border-b border-border px-2">
                <TabBar
                  label="Trace views"
                  tabs={TRACE_VIEWS}
                  value={view}
                  onChange={(next) => {
                    setView(next);
                    writeTraceView(next);
                  }}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-scrollable>
                {view === "timeline" &&
                  (bounds === null ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No spans were recorded for this trace.</p>
                  ) : (
                    <TimelineView spans={ordered} bounds={bounds} selected={selected} onSelect={setSelected} />
                  ))}
                {view === "tree" && <SpanTree spans={ordered} selected={selected} onSelect={setSelected} />}
                {view === "transcript" && (
                  <TranscriptView spans={ordered} steps={run?.steps ?? []} selected={selected} onSelect={setSelected} />
                )}
              </div>
            </div>

            {trace !== null && (
            <aside className="w-full space-y-4 xl:min-h-0 xl:w-[36%] xl:min-w-[24rem] xl:max-w-[40rem] xl:shrink-0 xl:overflow-y-auto" data-scrollable>
              <SpanDetail span={selected} admin={admin} />
              <div className="border-t border-border pt-3">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Trace</p>
                <dl className="mt-2 space-y-1.5 text-2xs">
                  <Meta label="Trace id" value={trace.trace_id} mono />
                  <Meta label="Agent" value={trace.agent_name || "—"} />
                  {trace.session_id !== null ? (
                    <div>
                      <dt className="text-muted-foreground">Chat</dt>
                      <dd>
                        <button
                          type="button"
                          onClick={() => onNavigate({ view: "chat", chatId: trace.session_id! })}
                          className="break-all font-mono underline decoration-border underline-offset-2 hover:decoration-foreground"
                        >
                          {trace.session_id}
                        </button>
                      </dd>
                    </div>
                  ) : (
                    <Meta label="Session" value="—" />
                  )}
                  {trace.parent_trace_id !== null && <Meta label="Parent trace" value={trace.parent_trace_id} mono />}
                  <Meta label="Trigger" value={triggerLabel(trace.trigger)} />
                </dl>
              </div>

              {trace.summary.trim() !== "" && (
                <details className="border-t border-border pt-3">
                  <summary className="cursor-pointer select-none text-2xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                    Summary
                  </summary>
                  <div className={cn("mt-2 text-sm text-foreground", MD_CLASS, MD_TABLE_CLASS)}>
                    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {trace.summary}
                    </Markdown>
                  </div>
                </details>
              )}

              {trace.error !== "" && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs text-destructive">
                  {trace.error}
                </p>
              )}

              {children.length > 0 && (
                <section className="border-t border-border pt-3">
                  <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Delegated traces</p>
                  <ul className="mt-2 divide-y divide-border/60">
                    {children.map((child) => (
                      <li key={child.trace_id}>
                        <button
                          type="button"
                          onClick={() => onNavigate({ view: "run", runId: child.trace_id })}
                          className="flex w-full items-start gap-2 py-2 text-left text-xs transition-colors hover:bg-accent/40"
                        >
                          <ToneBadge tone={toneOf(child.status)}>{statusLabel(child.status)}</ToneBadge>
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
                </section>
              )}
            </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function traceTitle(trace: TraceRow): string {
  const first = trace.summary
    .split("\n")
    .map((line) => line.replace(/[#*_`>]/g, "").trim())
    .find((line) => line !== "");
  if (first === undefined || first === "") return trace.agent_name || "Trace";
  return first.length > 140 ? `${first.slice(0, 140).trimEnd()}…` : first;
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function SpanIcon({ span, className }: { span: SpanRow; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded",
        span.status === "error"
          ? "bg-destructive/15 text-destructive"
          : span.span_type === "llm"
            ? "bg-violet-500/15 text-violet-300"
            : "bg-emerald-500/15 text-emerald-300",
        className,
      )}
    >
      {span.span_type === "llm" ? <Bot className="size-3" /> : <Wrench className="size-3" />}
    </span>
  );
}

function TimelineView({
  spans,
  bounds,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  bounds: { start: number; end: number };
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  const total = bounds.end - bounds.start;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div>
      <div className="grid grid-cols-[10rem_minmax(0,1fr)_4.5rem] gap-2 px-1 pb-1 text-2xs tabular-nums text-muted-foreground">
        <span />
        <div className="relative h-4">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${tick * 100}%` }}
            >
              {ms(total * tick)}
            </span>
          ))}
        </div>
        <span />
      </div>
      <div className="space-y-0.5">
        {spans.map((span) => {
          const left = ((Date.parse(span.start_time) - bounds.start) / total) * 100;
          const width = Math.max(0.5, (span.duration_ms / total) * 100);
          return (
            <button
              key={span.span_id}
              type="button"
              onClick={() => onSelect(span)}
              className={cn(
                "grid w-full grid-cols-[10rem_minmax(0,1fr)_4.5rem] items-center gap-2 rounded-sm border-l-2 px-1 py-0.5 text-left transition-colors focus:outline-none",
                selected?.span_id === span.span_id
                  ? "border-l-primary bg-primary/10"
                  : "border-l-transparent hover:bg-accent/40",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <SpanIcon span={span} className="size-4" />
                <span className="truncate">{span.name}</span>
              </span>
              <span className="relative h-5 rounded bg-accent/25">
                {[25, 50, 75].map((tick) => (
                  <span
                    key={tick}
                    className="absolute inset-y-0 border-l border-border/60"
                    style={{ left: `${tick}%` }}
                  />
                ))}
                <span
                  className={cn(
                    "absolute top-0.5 h-4 rounded",
                    span.status === "error"
                      ? "bg-destructive/70"
                      : span.span_type === "llm"
                        ? "bg-violet-500/70"
                        : "bg-emerald-500/70",
                  )}
                  style={{
                    left: `${Math.min(99.5, Math.max(0, left))}%`,
                    width: `${Math.min(100 - Math.max(0, left), Math.max(0.5, width))}%`,
                  }}
                />
              </span>
              <span className="text-right text-2xs tabular-nums text-muted-foreground">{ms(span.duration_ms)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpanList({
  spans,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  if (spans.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No spans were recorded for this trace.</p>;
  }
  return (
    <div className="divide-y divide-border/50">
      {spans.map((span) => (
        <button
          key={span.span_id}
          type="button"
          onClick={() => onSelect(span)}
          className={cn(
            "flex w-full items-start gap-2 border-l-2 px-2 py-2 text-left transition-colors focus:outline-none",
            selected?.span_id === span.span_id
              ? "border-l-primary bg-primary/10"
              : "border-l-transparent hover:bg-accent/40",
          )}
        >
          <SpanIcon span={span} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">{span.name}</span>
              {span.model !== "" && <span className="font-mono text-2xs text-muted-foreground">{span.model}</span>}
              {span.status === "error" && <ToneBadge tone="danger">error</ToneBadge>}
            </span>
            {spanPreview(span) !== "" && (
              <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{spanPreview(span)}</span>
            )}
          </span>
          <span className="shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
            {span.tokens_in + span.tokens_out > 0 && (
              <span className="block">{compact(totalTokens(span))} tok</span>
            )}
            <span className="block">{ms(span.duration_ms)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TranscriptView({
  spans,
  steps,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  steps: AgentRunStep[];
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  const llm = useMemo(() => spans.filter((span) => span.span_type === "llm"), [spans]);
  const tools = useMemo(() => spans.filter((span) => span.span_type === "tool"), [spans]);
  const toolByCall = useMemo(() => {
    const map = new Map<string, SpanRow>();
    for (const span of tools) {
      const callId = span.attributes["call_id"];
      if (typeof callId === "string") map.set(callId, span);
    }
    return map;
  }, [tools]);

  if (steps.length === 0) return <SpanList spans={spans} selected={selected} onSelect={onSelect} />;

  const nearestLlm = (at: string | null | undefined): SpanRow | null => {
    if (at === null || at === undefined) return null;
    const ts = Date.parse(at);
    if (!Number.isFinite(ts)) return null;
    let best: SpanRow | null = null;
    for (const span of llm) {
      const start = Date.parse(span.start_time);
      if (start <= ts && (best === null || start > Date.parse(best.start_time))) best = span;
    }
    return best;
  };

  return (
    <div className="divide-y divide-border/50">
      {steps.map((step, index) => {
        const key = `${step.kind}-${step.at ?? ""}-${index}`;
        if (step.kind === "user") {
          return (
            <div key={key} className="border-l-2 border-sky-400/60 bg-sky-400/5 px-3 py-2">
              <div className="flex items-center gap-1.5 text-2xs text-sky-300">
                <ArrowRight className="size-3.5" />
                <span className="font-medium uppercase tracking-wide">Input</span>
                {step.at !== null && step.at !== undefined && (
                  <span className="ml-auto text-muted-foreground">{time(step.at)}</span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{step.detail}</p>
            </div>
          );
        }
        if (step.kind === "assistant") {
          const span = nearestLlm(step.at);
          const selectedRow = span !== null && selected?.span_id === span.span_id;
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => span !== null && onSelect(span)}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && span !== null) onSelect(span);
              }}
              className={cn(
                "cursor-pointer border-l-2 px-3 py-2 transition-colors focus:outline-none",
                selectedRow
                  ? "border-l-primary bg-primary/10"
                  : "border-l-violet-400/60 hover:bg-accent/40",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-violet-300">
                <Bot className="size-3.5" />
                <span className="font-medium uppercase tracking-wide">Assistant</span>
                {span !== null && span.model !== "" && (
                  <span className="font-mono text-muted-foreground">{span.model}</span>
                )}
                {span !== null && (
                  <span className="text-muted-foreground">
                    {compact(totalTokens(span))} tok · {ms(span.duration_ms)}
                  </span>
                )}
              </div>
              <div className={cn("mt-1 text-sm text-foreground", MD_CLASS, MD_TABLE_CLASS)}>
                <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {step.detail ?? ""}
                </Markdown>
              </div>
            </div>
          );
        }
        if (step.kind === "tool") {
          const span =
            (step.call_id !== null && step.call_id !== undefined ? toolByCall.get(step.call_id) : undefined) ??
            tools.find((tool) => tool.name === step.name) ??
            null;
          const selectedRow = span !== null && selected?.span_id === span.span_id;
          const command = toolBody(span, step.detail ?? "");
          const result = step.detail === null || step.detail === undefined ? "" : oneLine(step.detail);
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => span !== null && onSelect(span)}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && span !== null) onSelect(span);
              }}
              className={cn(
                "cursor-pointer border-l-2 px-3 py-2 transition-colors focus:outline-none",
                selectedRow
                  ? "border-l-primary bg-primary/10"
                  : "border-l-emerald-400/60 hover:bg-accent/40",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-emerald-300">
                <Wrench className="size-3.5" />
                <span className="font-medium">{step.name ?? "tool"}</span>
                <ToneBadge tone={step.status === "error" ? "danger" : "success"}>
                  {step.status === "error" ? "error" : "ok"}
                </ToneBadge>
                {span !== null && <span className="text-muted-foreground">{ms(span.duration_ms)}</span>}
              </div>
              {(command.body !== "" || command.label !== "") && (
                <div className="mt-1 flex items-start gap-1.5">
                  {command.label !== "" && (
                    <span className="mt-0.5 shrink-0 rounded bg-muted px-1 font-mono text-2xs text-muted-foreground">
                      {command.label}
                    </span>
                  )}
                  {command.body !== "" && (
                    <pre className="line-clamp-2 overflow-hidden whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
                      {command.body}
                    </pre>
                  )}
                </div>
              )}
              {result !== "" && (
                <p className="mt-0.5 line-clamp-1 overflow-hidden break-words text-2xs text-muted-foreground/80">
                  → {result}
                </p>
              )}
            </div>
          );
        }
        if (step.kind === "file") {
          return (
            <div key={key} className="flex items-center gap-1.5 px-3 py-2 text-2xs text-muted-foreground">
              <FileText className="size-3.5" />
              <span className="font-mono">{step.detail}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

interface SpanNode {
  span: SpanRow;
  children: SpanNode[];
}

function buildSpanTree(spans: SpanRow[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>(spans.map((span) => [span.span_id, { span, children: [] }]));
  const roots: SpanNode[] = [];
  const ordered = [...spans].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  const llm = ordered.filter((span) => span.span_type === "llm");
  for (const span of ordered) {
    const node = nodes.get(span.span_id);
    if (node === undefined) continue;
    let parentId = span.parent_span_id;
    if (parentId === null || !nodes.has(parentId)) {
      if (span.span_type === "tool") {
        let candidate: SpanRow | null = null;
        for (const call of llm) {
          if (Date.parse(call.start_time) <= Date.parse(span.start_time)) candidate = call;
          else break;
        }
        parentId = candidate?.span_id ?? null;
      } else {
        parentId = null;
      }
    }
    if (parentId !== null && parentId !== span.span_id) {
      nodes.get(parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function SpanTree({
  spans,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const roots = useMemo(() => buildSpanTree(spans), [spans]);
  if (spans.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No spans were recorded for this trace.</p>;
  }
  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  function renderNode(node: SpanNode): React.ReactNode {
    const { span } = node;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(span.span_id);
    const preview = span.span_type === "tool" ? toolBody(span, "").body : spanPreview(span);
    return (
      <li key={span.span_id}>
        <div
          className={cn(
            "group flex h-8 items-center gap-1 border-l-2 pr-1 transition-colors",
            selected?.span_id === span.span_id
              ? "border-l-primary bg-primary/10"
              : "border-l-transparent hover:bg-accent/40",
          )}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={isCollapsed ? "Expand span" : "Collapse span"}
              onClick={() => toggle(span.span_id)}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => onSelect(span)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none"
          >
            <SpanIcon span={span} />
            <span className="w-40 shrink-0 truncate text-xs">{span.name}</span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{preview}</span>
            <span className="hidden w-44 shrink-0 truncate font-mono text-2xs text-muted-foreground sm:block">
              {span.model}
            </span>
            <span className="w-14 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
              {span.tokens_in + span.tokens_out > 0 ? compact(totalTokens(span)) : ""}
            </span>
            <span className="w-12 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
              {ms(span.duration_ms)}
            </span>
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                span.status === "error" ? "bg-destructive" : "bg-emerald-500",
              )}
            />
          </button>
        </div>
        {hasChildren && !isCollapsed && (
          <ul className="ml-3 border-l border-border/40 pl-2">{node.children.map((child) => renderNode(child))}</ul>
        )}
      </li>
    );
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 border-b border-border/60 px-1 pb-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <span className="size-4 shrink-0" />
        <span className="size-5 shrink-0" />
        <span className="-ml-1.5 w-40 shrink-0">Span</span>
        <span className="min-w-0 flex-1" />
        <span className="hidden w-44 shrink-0 sm:block">Model</span>
        <span className="w-14 shrink-0 text-right">Tokens</span>
        <span className="w-12 shrink-0 text-right">Time</span>
        <span className="w-1.5 shrink-0" />
      </div>
      <ul>{roots.map((node) => renderNode(node))}</ul>
    </div>
  );
}

function SpanDetail({ span, admin }: { span: SpanRow | null; admin: boolean }) {
  const [payloads, setPayloads] = useState<{ kind: string; body: string }[] | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [rawInput, setRawInput] = useState(false);

  useEffect(() => {
    setRawInput(false);
  }, [span?.span_id, span?.span_type]);

  useEffect(() => {
    setPayloads(null);
    setPayloadError(null);
    if (span === null || !admin || span.span_type !== "llm") return;
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
  }, [span?.span_id, span?.span_type, admin]);

  if (span === null) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-2xs text-muted-foreground">
        Select a span to inspect its input, output and attributes.
      </div>
    );
  }

  const requestRaw = payloads?.find((row) => row.kind === "request")?.body ?? "";
  const responseRaw = payloads?.find((row) => row.kind === "response")?.body ?? "";
  const request = parseObject(requestRaw);
  const response = parseObject(responseRaw);
  const messages = payloadMessages(request?.["messages"]);
  const responseContent = typeof response?.["content"] === "string" ? response["content"] : "";
  const inputText =
    messages !== null && !rawInput ? JSON.stringify(request?.["messages"]) : span.input || requestRaw;
  const outputText = responseContent || span.output || responseRaw;
  const attributesText = JSON.stringify(span.attributes, null, 2);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SpanIcon span={span} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{span.name}</span>
        <span className="shrink-0">
          <ToneBadge tone={toneOf(span.status)}>{statusLabel(span.status)}</ToneBadge>
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{ms(span.duration_ms)}</span>
      </div>
      <div className="divide-y divide-border">
        {span.span_type === "llm" && (
          <SpanSection title="Overview">
            <SpanOverview span={span} />
          </SpanSection>
        )}
        <SpanSection title="Input" copy={inputText}>
          {span.span_type === "llm" && messages !== null && messages.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setRawInput(false)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-2xs",
                    !rawInput ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Messages
                </button>
                <button
                  type="button"
                  onClick={() => setRawInput(true)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-2xs",
                    rawInput ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  JSON
                </button>
              </div>
              {rawInput ? <JsonView value={requestRaw} /> : <MessagesView messages={messages} />}
            </div>
          ) : (
            <PayloadValue
              value={span.input}
              empty={
                span.span_type === "llm"
                  ? admin
                    ? "No input payload was captured for this call."
                    : "Payload bodies are admin-only."
                  : "No input was recorded."
              }
            />
          )}
        </SpanSection>
        <SpanSection title="Output" copy={outputText}>
          {span.span_type === "llm" && response !== null ? (
            <ResponseView response={response} fallback={span.output || responseRaw} />
          ) : (
            <PayloadValue value={span.output || responseRaw} empty="No output was recorded." />
          )}
        </SpanSection>
        <SpanSection title="Attributes" copy={attributesText}>
          <JsonView value={attributesText} />
        </SpanSection>
      </div>
      {payloadError !== null && <p className="px-3 pb-2 text-2xs text-destructive">{payloadError}</p>}
    </div>
  );
}

function SpanSection({
  title,
  copy,
  children,
}: {
  title: string;
  copy?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {copy !== undefined && copy !== "" && <CopyButton value={copy} />}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </section>
  );
}

interface ResponseToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}

function ResponseView({ response, fallback }: { response: Record<string, unknown>; fallback: string }) {
  const content = typeof response["content"] === "string" ? response["content"] : "";
  const reasoning = typeof response["reasoning_content"] === "string" ? response["reasoning_content"] : "";
  const toolCalls = Array.isArray(response["tool_calls"]) ? (response["tool_calls"] as ResponseToolCall[]) : [];
  const hasToolCalls = toolCalls.length > 0;
  if (content === "" && !hasToolCalls && reasoning === "") {
    return <JsonView value={fallback} />;
  }
  return (
    <div className="space-y-2">
      {content !== "" && (
        <div className={cn("text-sm text-foreground", MD_CLASS, MD_TABLE_CLASS)}>
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {content}
          </Markdown>
        </div>
      )}
      {toolCalls.map((call, index) => {
        const name = call.name ?? call.function?.name ?? "tool_call";
        const args = call.arguments ?? call.function?.arguments;
        return (
          <div key={call.id ?? index} className="rounded-md border border-border bg-background/60 p-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Wrench className="size-3 shrink-0 text-emerald-300" />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">{name}</span>
            </div>
            {call.id !== undefined && (
              <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">{call.id}</p>
            )}
            <JsonView
              value={typeof args === "string" ? args : JSON.stringify(args ?? {})}
              maxHeight="max-h-48"
              className="mt-1"
            />
          </div>
        );
      })}
      {reasoning !== "" && (
        <details>
          <summary className="cursor-pointer text-2xs text-muted-foreground">Reasoning</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
            {reasoning}
          </pre>
        </details>
      )}
    </div>
  );
}

function SpanOverview({ span }: { span: SpanRow }) {
  const finishReason = typeof span.attributes["finish_reason"] === "string" ? span.attributes["finish_reason"] : "";
  const verdict = span.attributes["verdict"];
  const verdictReason = typeof span.attributes["verdict_reason"] === "string" ? span.attributes["verdict_reason"] : "";
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-2xs">
        <Meta label="Model" value={span.model || "—"} />
        <Meta label="Caller" value={span.caller || "—"} />
        <Meta label="Tokens" value={`${compact(span.tokens_in)} in / ${compact(span.tokens_out)} out`} />
        <Meta label="Cost" value={money(span.cost_usd)} />
        <Meta label="Latency" value={ms(span.duration_ms)} />
        <Meta label="Status" value={statusLabel(span.status)} />
        {finishReason !== "" && <Meta label="Finish" value={finishReason} />}
        {verdict !== undefined && verdict !== null && (
          <Meta label="Verdict" value={String(verdict)} />
        )}
      </dl>
      {verdictReason !== "" && <p className="text-2xs text-muted-foreground">{verdictReason}</p>}
      {span.error !== "" && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs text-destructive">
          {span.error}
        </p>
      )}
    </div>
  );
}

function PayloadValue({ value, empty }: { value: string; empty: string }) {
  if (value.trim() === "") {
    return <p className="text-2xs text-muted-foreground">{empty}</p>;
  }
  return <JsonView value={value} />;
}

function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy value"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

function parseObject(value: string): Record<string, unknown> | null {
  if (value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toolBody(span: SpanRow | null, fallback: string): { label: string; body: string } {
  const raw = span !== null && span.input.trim() !== "" ? span.input : fallback;
  const parsed = parseObject(raw);
  if (parsed !== null) {
    if (typeof parsed["command"] === "string") return { label: "bash", body: parsed["command"] };
    if (typeof parsed["path"] === "string") {
      const body =
        typeof parsed["content"] === "string"
          ? parsed["content"]
          : typeof parsed["newText"] === "string"
            ? parsed["newText"]
            : "";
      return { label: parsed["path"], body };
    }
  }
  return { label: "", body: raw };
}
