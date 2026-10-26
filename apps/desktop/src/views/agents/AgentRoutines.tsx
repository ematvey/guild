import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Clock,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { nextRunLabel, relativeTime } from "../../lib/relative-time";
import {
  getRoutine,
  listRoutineRuns,
  listRoutines,
  runRoutine,
  type AgentRoutine,
  type AgentRun,
} from "./agents-api";
import type { AgentsRoute } from "./agents-route";
import {
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadingRows,
  Mono,
  RunStatusBadge,
  Section,
  ToneBadge,
} from "./agent-ui";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Turns the stored five-field cron into the sentence the UI shows. The raw
 *  expression stays available in the element's title for debugging, but it is
 *  never the primary label. */
export function humanSchedule(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return "Custom schedule";
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  if (month !== "*") return "Custom schedule";

  if (minute === "*" && hour === "*" && day === "*" && weekday === "*") {
    return "Every minute";
  }
  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep && hour === "*" && day === "*" && weekday === "*") {
    return `Every ${minuteStep[1]} minutes`;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (minute === "0" && hourStep && day === "*" && weekday === "*") {
    return `Every ${hourStep[1]} hours`;
  }
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return "Custom schedule";

  const at = clock(Number(hour), Number(minute));
  if (day === "*" && weekday === "*") return `Daily at ${at}`;
  if (day === "*" && weekday === "1-5") return `Weekdays at ${at}`;
  if (day === "*" && /^[0-6]$/.test(weekday)) return `Every ${WEEKDAYS[Number(weekday)]} at ${at}`;
  if (day === "*" && /^([0-6],)+[0-6]$/.test(weekday)) {
    return `Every ${weekday
      .split(",")
      .map((value) => WEEKDAYS[Number(value)])
      .join(", ")} at ${at}`;
  }
  if (/^\d+$/.test(day) && weekday === "*") return `Monthly on day ${day} at ${at}`;
  return "Custom schedule";
}

export function scheduleLabel(routine: AgentRoutine): string {
  if (routine.kind === "once") {
    return routine.run_at
      ? `Once on ${new Date(routine.run_at).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}`
      : "Once";
  }
  return `${humanSchedule(routine.schedule ?? "")} · ${routine.timezone}`;
}

export function AgentRoutines({
  agentId,
  routineId,
  onNavigate,
  onNewRoutine,
  onEditRoutine,
}: {
  agentId: string;
  routineId?: string;
  onNavigate: (route: AgentsRoute) => void;
  onNewRoutine: () => Promise<void>;
  onEditRoutine: (routine: AgentRoutine) => Promise<void>;
}) {
  if (routineId && routineId !== "new") {
    return (
      <RoutineDetail
        agentId={agentId}
        routineId={routineId}
        onNavigate={onNavigate}
        onEditRoutine={onEditRoutine}
      />
    );
  }
  return (
    <RoutineList
      agentId={agentId}
      onNavigate={onNavigate}
      onNewRoutine={onNewRoutine}
    />
  );
}

function RoutineList({
  agentId,
  onNavigate,
  onNewRoutine,
}: {
  agentId: string;
  onNavigate: (routes: AgentsRoute) => void;
  onNewRoutine: () => Promise<void>;
}) {
  const [routines, setRoutines] = useState<AgentRoutine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void listRoutines(agentId)
      .then((rows) => {
        if (live) setRoutines(rows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setRoutines(null);
        setError(err instanceof Error ? err.message : "The routines API did not answer.");
      });
    return () => {
      live = false;
    };
  }, [agentId, tick]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await onNewRoutine();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open a routine thread.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Routines run on a schedule in an isolated context. Ask the agent to create or change one.
        </p>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw />
          Refresh
        </Button>
        <Button size="sm" onClick={() => void start()} disabled={starting}>
          {starting ? <Loader2 className="animate-spin" /> : <Plus />}
          New routine
        </Button>
      </div>
      {error !== null && (
        <ErrorState
          title="Could not load routines"
          message={error}
          onRetry={() => setTick((t) => t + 1)}
        />
      )}
      {error === null && routines === null && <LoadingRows rows={3} />}
      {error === null && routines !== null && routines.length === 0 && (
        <EmptyState
          icon={<Clock className="size-5" />}
          title="No routines yet"
          body="Start a chat with the agent and describe what should run, when, and in which timezone."
          action={
            <Button size="sm" onClick={() => void start()} disabled={starting}>
              {starting ? <Loader2 className="animate-spin" /> : <Plus />}
              New routine
            </Button>
          }
        />
      )}
      {error === null && routines !== null && routines.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {routines.map((routine) => (
            <button
              key={routine.id}
              type="button"
              onClick={() =>
                onNavigate({
                  view: "agent",
                  agentId,
                  tab: "routines",
                  routineId: routine.id,
                })
              }
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50"
            >
              <Clock className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{routine.name}</span>
                  <ToneBadge tone={routine.enabled ? "success" : "neutral"}>
                    {routine.enabled ? "Enabled" : "Paused"}
                  </ToneBadge>
                  {routine.kind === "once" && <ToneBadge tone="info">Reminder</ToneBadge>}
                </span>
                <span
                  className="mt-0.5 block truncate text-xs text-muted-foreground"
                  title={routine.schedule ?? undefined}
                >
                  {scheduleLabel(routine)}
                  {routine.next_run_at
                    ? ` · next ${nextRunLabel(routine.next_run_at)}`
                    : ""}
                </span>
              </span>
              {routine.last_run && <RunStatusBadge status={routine.last_run.status} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoutineDetail({
  agentId,
  routineId,
  onNavigate,
  onEditRoutine,
}: {
  agentId: string;
  routineId: string;
  onNavigate: (routes: AgentsRoute) => void;
  onEditRoutine: (routine: AgentRoutine) => Promise<void>;
}) {
  const [routine, setRoutine] = useState<AgentRoutine | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void getRoutine(agentId, routineId)
      .then((row) => {
        if (live) setRoutine(row);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "Could not load this routine.");
      });
    void listRoutineRuns(agentId, routineId)
      .then((rows) => {
        if (live) setRuns(rows);
      })
      .catch(() => {
        if (live) setRuns([]);
      });
    return () => {
      live = false;
    };
  }, [agentId, routineId, tick]);

  const runNow = async () => {
    setRunning(true);
    setActionError(null);
    try {
      await runRoutine(agentId, routineId);
      setTick((t) => t + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start the routine.");
    } finally {
      setRunning(false);
    }
  };

  const edit = async () => {
    if (!routine) return;
    setEditing(true);
    setActionError(null);
    try {
      await onEditRoutine(routine);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not open a routine thread.");
    } finally {
      setEditing(false);
    }
  };

  if (error !== null) {
    return (
      <div className="space-y-4">
        <BackButton onNavigate={onNavigate} agentId={agentId} />
        <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
      </div>
    );
  }
  if (routine === null) return <InlineLoading label="Loading routine" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <BackButton onNavigate={onNavigate} agentId={agentId} />
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={running}>
          {running ? <Loader2 className="animate-spin" /> : <Play />}
          Run now
        </Button>
        <Button variant="outline" size="sm" onClick={() => void edit()} disabled={editing}>
          {editing ? <Loader2 className="animate-spin" /> : <Pencil />}
          Edit via agent
        </Button>
      </div>

      <Section title="Routine" description="Schedules and prompts are managed in chat.">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Name</dt>
            <dd className="mt-0.5">{routine.name}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Status</dt>
            <dd className="mt-0.5">
              <ToneBadge tone={routine.enabled ? "success" : "neutral"}>
                {routine.enabled ? "Enabled" : "Paused"}
              </ToneBadge>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Schedule</dt>
            <dd className="mt-0.5" title={routine.schedule ?? undefined}>
              {scheduleLabel(routine)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Next run</dt>
            <dd className="mt-0.5 text-muted-foreground">
              {routine.next_run_at ? nextRunLabel(routine.next_run_at) : "Not scheduled"}
            </dd>
          </div>
        </dl>
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground">Prompt</p>
          <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
            {routine.prompt}
          </p>
        </div>
        <p className="mt-3 text-2xs text-muted-foreground">
          The run gets these instructions, this prompt and the workspace. It does not see the default thread.
        </p>
      </Section>

      {actionError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      <Section title="Run history" description="Occurrences of this routine, newest first.">
        {runs === null ? (
          <InlineLoading label="Loading runs" />
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">This routine has not run yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                <RunStatusBadge status={run.status} />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {run.summary?.trim() || "No summary"}
                </span>
                <Mono>{run.id.slice(0, 8)}</Mono>
                <span className="text-muted-foreground">
                  {relativeTime(run.started_at ?? run.created_at)}
                </span>
                <button
                  type="button"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => onNavigate({ view: "run", runId: run.id })}
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function BackButton({
  agentId,
  onNavigate,
}: {
  agentId: string;
  onNavigate: (routes: AgentsRoute) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onNavigate({ view: "agent", agentId, tab: "routines" })}
    >
      <ArrowLeft />
      Routines
    </Button>
  );
}
