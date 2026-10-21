import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  Clock,
  FileText,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { relativeTime } from "../../lib/relative-time";
import {
  RUN_STATUS_LABEL,
  RUN_TRIGGER_LABEL,
  agentsRoutePath,
  type AgentsRoute,
  type RunStatus,
  type RunTrigger,
} from "./agents-route";
import {
  getRun,
  listActivity,
  listAgents,
  listRunArtifacts,
  listRunChildren,
  type Agent,
  type AgentArtifact,
  type AgentRun,
} from "./agents-api";
import {
  AgentGlyph,
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadingRows,
  PageBody,
  PageHeader,
  RunStatusBadge,
  Section,
} from "./agent-ui";

const STATUSES: RunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "silent",
  "skipped",
];
const TRIGGERS: RunTrigger[] = ["message", "routine", "manual", "delegation"];

export function runDuration(run: AgentRun): string {
  if (!run.started_at) return "—";
  const start = Date.parse(run.started_at);
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function activitySubtitle(run: AgentRun): string {
  const parts = [RUN_TRIGGER_LABEL[run.trigger]];
  if (run.routine_name) parts.push(run.routine_name);
  else if (run.thread_id) parts.push("Thread");
  return parts.join(" · ");
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
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [trigger, setTrigger] = useState<RunTrigger | "all">("all");
  const [agentFilter, setAgentFilter] = useState(agentId ?? "all");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!agentId) void listAgents().then(setAgents).catch(() => setAgents([]));
  }, [agentId]);

  useEffect(() => {
    let live = true;
    setError(null);
    void listActivity({
      agent: agentId ?? (agentFilter === "all" ? undefined : agentFilter),
      status,
      trigger,
    })
      .then((rows) => {
        if (live) setRuns(rows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setRuns(null);
        setError(err instanceof Error ? err.message : "The activity API did not answer.");
      });
    return () => {
      live = false;
    };
  }, [agentId, agentFilter, status, trigger, tick]);

  const rows = useMemo(
    () =>
      [...(runs ?? [])].sort(
        (a, b) => Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at),
      ),
    [runs],
  );

  const body = (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {!agentId && (
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger aria-label="Filter by agent" className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={status} onValueChange={(v) => setStatus(v as RunStatus | "all")}>
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
        <Select value={trigger} onValueChange={(v) => setTrigger(v as RunTrigger | "all")}>
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
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          aria-label="Refresh activity"
          onClick={() => setTick((t) => t + 1)}
        >
          <RefreshCw />
          Refresh
        </Button>
      </div>

      {error !== null && (
        <ErrorState
          title="Could not load activity"
          message={error}
          onRetry={() => setTick((t) => t + 1)}
        />
      )}
      {error === null && runs === null && <LoadingRows rows={6} />}
      {error === null && runs !== null && rows.length === 0 && (
        <EmptyState
          icon={<Activity className="size-5" />}
          title="No runs yet"
          body="Runs appear here as the agent works. Silent runs are recorded too."
        />
      )}
      {error === null && rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onNavigate({ view: "run", runId: run.id })}
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
                {run.trigger === "routine" ? (
                  <Clock className="size-4" />
                ) : run.trigger === "message" ? (
                  <MessageSquare className="size-4" />
                ) : (
                  <Activity className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {run.summary?.trim() || `${RUN_TRIGGER_LABEL[run.trigger]} run`}
                  </span>
                  {!agentId && run.agent_name && (
                    <span className="truncate text-xs text-muted-foreground">
                      · {run.agent_name}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {activitySubtitle(run)}
                </span>
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                {runDuration(run)}
              </span>
              <RunStatusBadge status={run.status} />
              <span className="hidden shrink-0 text-xs text-muted-foreground md:block">
                {relativeTime(run.started_at ?? run.created_at)}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      {onOpenChat !== undefined && agentId === undefined && (
        <p className="mt-3 text-xs text-muted-foreground">
          Activity records every run, including silent runs that did not open a thread.
        </p>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title="Activity"
        description="Every agent run, newest first."
      />
      <PageBody>{body}</PageBody>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [run, setRun] = useState<AgentRun | null>(null);
  const [children, setChildren] = useState<AgentRun[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void getRun(runId)
      .then((row) => {
        if (live) setRun(row);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "The run did not load.");
      });
    void listRunChildren(runId)
      .then((rows) => {
        if (live) setChildren(rows);
      })
      .catch(() => {});
    void listRunArtifacts(runId)
      .then((rows) => {
        if (live) setArtifacts(rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [runId, tick]);

  const agent = run?.agent_id;
  const thread =
    run?.thread_id && agent
      ? ({ view: "agent", agentId: agent, tab: "threads", threadId: run.thread_id } as const)
      : null;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title="Run"
        description={run?.id ?? runId}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ view: "activity" })}>
              <ArrowLeft />
              Activity
            </Button>
          </>
        }
      />
      <PageBody className="max-w-[56rem]">
        {error !== null && (
          <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
        )}
        {error === null && run === null && <InlineLoading label="Loading run" />}
        {run !== null && (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <RunStatusBadge status={run.status} />
                <span className="text-sm text-muted-foreground">
                  {RUN_TRIGGER_LABEL[run.trigger]}
                </span>
                {run.agent_name && agent && (
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
                    onClick={() => onNavigate({ view: "agent", agentId: agent, tab: "overview" })}
                  >
                    <AgentGlyph name={run.agent_name} className="size-4 rounded text-3xs" />
                    {run.agent_name}
                  </button>
                )}
                <span className="flex-1" />
                <span className="text-xs text-muted-foreground">
                  {relativeTime(run.started_at ?? run.created_at)}
                </span>
              </div>
              <p className="mt-3 text-sm font-medium">
                {run.summary?.trim() || "No summary was recorded."}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd>{run.finished_at ? new Date(run.finished_at).toLocaleString() : "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd>{runDuration(run)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd>{run.tokens ?? "—"}</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                {thread !== null && (
                  <Button variant="outline" size="sm" onClick={() => onNavigate(thread)}>
                    <MessageSquare />
                    Open thread
                  </Button>
                )}
                {run.chat_id && onOpenChat && (
                  <Button variant="ghost" size="sm" onClick={() => onOpenChat(run.chat_id!)}>
                    Open in Chats
                  </Button>
                )}
              </div>
            </div>

            {run.error_message && (
              <Section title="Error">
                <p className="text-sm text-destructive">{run.error_message}</p>
                {(run.error_code || run.error_step) && (
                  <p className="mt-1 font-mono text-2xs text-muted-foreground">
                    {[run.error_code, run.error_step].filter(Boolean).join(" · ")}
                  </p>
                )}
              </Section>
            )}

            <Section title="Steps" description="Model turns and tool calls in order.">
              {(run.steps ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No steps were recorded.</p>
              ) : (
                <ol className="space-y-1.5">
                  {run.steps!.map((step, i) => (
                    <li
                      key={`${step.kind}-${i}`}
                      className="flex items-start gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      <span className="mt-0.5 font-mono text-2xs text-muted-foreground">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{step.name ?? step.kind}</span>
                        {step.detail && (
                          <span className="mt-0.5 block break-words text-muted-foreground">
                            {step.detail}
                          </span>
                        )}
                      </span>
                      {step.status && (
                        <span
                          className={`shrink-0 text-2xs ${
                            step.is_error ? "text-destructive" : "text-muted-foreground"
                          }`}
                        >
                          {step.status}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            {children.length > 0 && (
              <Section title="Delegated runs" description="Child runs this run spawned.">
                <ul className="space-y-1.5">
                  {children.map((child) => (
                    <li key={child.id}>
                      <button
                        type="button"
                        onClick={() => onNavigate({ view: "run", runId: child.id })}
                        className="flex w-full items-start gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                      >
                        <span className="mt-0.5">
                          <RunStatusBadge status={child.status} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">
                            {child.agent_name ?? "Delegated agent"}
                          </span>
                          {child.summary && (
                            <span className="mt-0.5 block break-words text-muted-foreground">
                              {child.summary}
                            </span>
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
              <Section title="Artifacts" description="Files the delegated run returned.">
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

            <Section title="Files touched">
              {(run.files ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No files were touched.</p>
              ) : (
                <ul className="space-y-1">
                  {run.files!.map((path) => (
                    <li key={path} className="flex items-center gap-2 text-xs">
                      <FileText className="size-3.5 text-muted-foreground" />
                      <span className="break-all font-mono">{path}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {run.parent_run_id && (
              <Section title="Parent run">
                <button
                  type="button"
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  onClick={() => onNavigate({ view: "run", runId: run.parent_run_id! })}
                >
                  Open parent run {run.parent_run_id}
                </button>
              </Section>
            )}
          </div>
        )}
      </PageBody>
    </div>
  );
}

/** Small link helper used by agent pages. */
export function activityRouteForAgent(agentId: string): AgentsRoute {
  return { view: "agent", agentId, tab: "activity" };
}

export { agentsRoutePath };
