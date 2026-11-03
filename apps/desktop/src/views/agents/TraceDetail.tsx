// One trace, three readings of the same spans: the conversation transcript,
// the span tree and the time waterfall. The right pane is the selected span:
// overview, input, output and attributes, with readable JSON.

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, ChevronRight, CornerUpLeft, MessageSquare, RefreshCw } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@guild/ui/components/button";
import { cn } from "@guild/ui/lib/utils";
import { relativeTime } from "../../lib/relative-time";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import { getRun, getTrace, type AgentRun, type RunThread, type SpanRow, type TraceRow } from "./agents-api";
import { AGENTS_ACTIVITY, type AgentsRoute, type TraceView } from "./agents-route";
import { runFinishes, traceWithRun, useAgentRunUpdates } from "./agents-store";
import { compact, money, ms, statusLabel, time, toneOf, totalTokens, triggerLabel } from "./activity-format";
import { ErrorState, InlineLoading, TabBar, ToneBadge } from "./agent-ui";
import { SpanDetail } from "./span-detail";
import { Meta, SpanTree, TimelineView, TranscriptView } from "./trace-views";

const TRACE_VIEWS: ReadonlyArray<readonly [TraceView, string]> = [
  ["transcript", "Transcript"],
  ["tree", "Tree"],
  ["timeline", "Timeline"],
];

export function RunDetailPage({
  runId,
  traceOnly = false,
  view,
  role,
  onNavigate,
  onOpenChat,
}: {
  runId: string;
  /** The route holds a trace id with no agent run behind it. */
  traceOnly?: boolean;
  /** The trace reading, from the route. */
  view: TraceView;
  /** The signed-in user's workspace role. */
  role: string;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
}) {
  const [trace, setTrace] = useState<TraceRow | null>(null);
  const [spans, setSpans] = useState<SpanRow[]>([]);
  const [children, setChildren] = useState<TraceRow[]>([]);
  const [selected, setSelected] = useState<SpanRow | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [thread, setThread] = useState<RunThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const pushedRun = useRef<AgentRun | null>(null);
  /** The status on screen; frames compare against it without waiting for a
   *  render. */
  const shownStatus = useRef<string | null>(null);

  useEffect(() => {
    pushedRun.current = null;
    shownStatus.current = null;
  }, [runId]);

  useEffect(() => {
    let live = true;
    setError(null);
    void getTrace(runId)
      .then((value) => {
        if (!live) return;
        // The trace store can lag the run row: the last pushed run still wins
        // for the fields it carries.
        const pushed = pushedRun.current;
        const next = pushed !== null && pushed.id === runId ? traceWithRun(value.trace, pushed) : value.trace;
        shownStatus.current = next.status;
        setTrace(next);
        setSpans(value.spans);
        setChildren(value.children);
        setSelected((current) => {
          if (current !== null && value.spans.some((span) => span.span_id === current.span_id)) return current;
          const ordered = [...value.spans].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
          return ordered.find((span) => span.span_type === "llm") ?? ordered[0] ?? null;
        });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "The run did not load.");
      });
    if (traceOnly) {
      setRun(null);
      setThread(null);
    } else {
      void getRun(runId)
        .then(({ run: value, thread: parent }) => {
          if (!live) return;
          shownStatus.current ??= value.status;
          setRun(value);
          setThread(parent);
        })
        .catch(() => {
          if (live) {
            setRun(null);
            setThread(null);
          }
        });
    }
    return () => {
      live = false;
    };
  }, [runId, traceOnly, tick]);

  // A running run finishes on screen: every pushed change to this run moves
  // the run row and the trace header (status, summary, end, error, tokens,
  // duration). The frame carries the run, not its spans or transcript: those
  // are ClickHouse analytics behind the trace endpoint, so the frame that
  // moves the run into a terminal status triggers one re-read of the trace
  // and the run. It is event-driven, once per finish, not a poll.
  useAgentRunUpdates((pushed) => {
    if (pushed.id !== runId) return;
    const finishes = runFinishes(shownStatus.current, pushed);
    pushedRun.current = pushed;
    shownStatus.current = pushed.status;
    setRun((prev) => (prev === null ? prev : { ...prev, ...pushed }));
    setTrace((prev) => (prev === null ? prev : traceWithRun(prev, pushed)));
    if (finishes) setTick((t) => t + 1);
  });

  const ordered = useMemo(
    () => [...spans].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time)),
    [spans],
  );
  const bounds = useMemo(() => {
    const spanStarts = ordered.map((span) => Date.parse(span.start_time));
    const spanEnds = ordered.map((span) =>
      span.end_time === null ? Date.parse(span.start_time) + span.duration_ms : Date.parse(span.end_time),
    );
    const traceStart =
      trace?.started_at === null || trace?.started_at === undefined ? NaN : Date.parse(trace.started_at);
    const traceEnd =
      trace?.finished_at === null || trace?.finished_at === undefined ? NaN : Date.parse(trace.finished_at);
    const starts = Number.isFinite(traceStart) ? [...spanStarts, traceStart] : spanStarts;
    const ends = Number.isFinite(traceEnd) ? [...spanEnds, traceEnd] : spanEnds;
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    return { start, end: Math.max(...ends, start + 1) };
  }, [ordered, trace?.started_at, trace?.finished_at]);

  const admin = role === "admin";
  const chatId = trace?.session_id ?? thread?.chat_id ?? null;
  const title = trace === null ? runId : traceTitle(trace);
  // The run's first user message: what the run was asked to do.
  const triggerText = (run?.steps ?? []).find((step) => step.kind === "user")?.detail ?? "";

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            onClick={() => onNavigate(chatId === null ? AGENTS_ACTIVITY : { view: "chat", chatId })}
          >
            <ArrowLeft />
            {chatId === null ? "Activity" : "Conversation"}
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
            <Button variant="ghost" size="sm" aria-label="Refresh run" onClick={() => setTick((t) => t + 1)}>
              <RefreshCw />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onNavigate(AGENTS_ACTIVITY)}>
              <Activity />
              Activity
            </Button>
            {thread?.parent_chat_id != null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate({ view: "chat", chatId: thread.parent_chat_id! })}
              >
                <CornerUpLeft />
                Parent thread
              </Button>
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
            <InlineLoading label="Loading run" />
          </div>
        )}
        {(trace !== null || spans.length > 0) && (
          <div className="flex min-h-full w-full flex-col gap-4 px-4 pb-16 pt-4 sm:px-6 xl:h-full xl:min-h-0 xl:flex-row xl:pb-4">
            <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card xl:min-h-0 xl:flex-1">
              <div className="shrink-0 border-b border-border px-2">
                <TabBar
                  label="Run views"
                  tabs={TRACE_VIEWS}
                  value={view}
                  onChange={(next) =>
                    onNavigate(
                      traceOnly
                        ? { view: "trace", traceId: runId, traceView: next }
                        : { view: "run", runId, traceView: next },
                    )
                  }
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-scrollable>
                {view === "timeline" &&
                  (bounds === null ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      No spans were recorded for this trace.
                    </p>
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
              <aside
                className="w-full space-y-4 xl:min-h-0 xl:w-[36%] xl:min-w-[24rem] xl:max-w-[40rem] xl:shrink-0 xl:overflow-y-auto"
                data-scrollable
              >
                <SpanDetail span={selected} admin={admin} />
                <div className="border-t border-border pt-3">
                  <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Run</p>
                  <dl className="mt-2 space-y-1.5 text-2xs">
                    <Meta label="Run id" value={trace.trace_id} mono />
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
                    {trace.parent_trace_id !== null && <Meta label="Parent run" value={trace.parent_trace_id} mono />}
                    <Meta label="Trigger" value={triggerLabel(trace.trigger)} />
                    {thread !== null && thread.parent_chat_id !== null && (
                      <div>
                        <dt className="text-muted-foreground">Parent thread</dt>
                        <dd>
                          <button
                            type="button"
                            onClick={() => onNavigate({ view: "chat", chatId: thread.parent_chat_id! })}
                            className="break-all text-left underline decoration-border underline-offset-2 hover:decoration-foreground"
                          >
                            {thread.parent_title !== null && thread.parent_title !== ""
                              ? thread.parent_title
                              : thread.parent_chat_id}
                          </button>
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>

                {triggerText !== "" && (
                  <section className="border-t border-border pt-3">
                    <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Trigger</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{triggerText}</p>
                  </section>
                )}

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
                    <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Delegated runs</p>
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
  if (first === undefined || first === "") return trace.agent_name || "Run";
  return first.length > 140 ? `${first.slice(0, 140).trimEnd()}…` : first;
}
