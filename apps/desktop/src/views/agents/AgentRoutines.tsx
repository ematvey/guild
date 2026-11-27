import { useEffect, useState } from "react";
import { ChevronRight, Clock, Ellipsis, Loader2, Pencil, Play, Plus } from "lucide-react";
import { PageHeader } from "../../components/page-header";
import { Button } from "@guild/ui/components/button";
import { nextRunLabel, relativeTime } from "../../lib/relative-time";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { createAgentThread, sendAgentTurn, listRoutineRuns, runRoutine, updateRoutine, type AgentRoutine, type AgentRun } from "./agents-api";
import { upsertRun, useAgentRoutines, useAgentRunUpdates } from "./agents-store";
import type { AgentsRoute } from "./agents-route";
import { ErrorState, LoadingRows, Mono, RunStatusBadge, ToneBadge } from "./agent-ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@guild/ui/components/dropdown-menu";
import { EmptyState } from "@guild/ui/components/empty-state";

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

export function AgentRoutinesPage({ agentId, routineId, canManage, onNavigate, onOpenChat }: {
  agentId: string;
  routineId?: string;
  canManage: boolean;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat: (chatId: string) => void;
}) {
  /** Routines are written in chat: open a fresh thread and hand the agent the
   *  intent, so the schedule, prompt and later changes all live in the
   *  transcript instead of a form. */
  const startRoutineThread = async (title: string, message: string) => {
    const row = await createAgentThread(agentId, title);
    await sendAgentTurn(agentId, { thread_id: row.id, message });
    onOpenChat(row.chat_id);
  };

  const newRoutine = () =>
    startRoutineThread(
      "New routine",
      "I want to create a new routine. Ask me what it should do, how often it should run " +
        "(for example weekdays at 09:00), and the timezone. Once I answer, create it with " +
        "create_routine and show me the human-readable schedule.",
    );

  const editRoutine = (routine: AgentRoutine) => {
    const current =
      routine.kind === "once"
        ? `once on ${routine.run_at ? new Date(routine.run_at).toLocaleString() : "an unset date"}`
        : `${humanSchedule(routine.schedule ?? "")} (${routine.timezone})`;
    return startRoutineThread(
      `Edit routine: ${routine.name}`,
      `I want to change the routine "${routine.name}" (${routine.id}). Its current schedule is ` +
        `${current}. Ask me what to change, then update it with update_routine. If I ask to remove ` +
        "it, use delete_routine. Describe schedule changes in plain language, not cron.",
    );
  };

  return <AgentRoutines agentId={agentId} routineId={routineId} canManage={canManage}
    onNavigate={onNavigate} onNewRoutine={newRoutine} onEditRoutine={editRoutine} />;
}

export function AgentRoutines({
  agentId,
  routineId,
  canManage,
  onNavigate,
  onNewRoutine,
  onEditRoutine,
}: {
  agentId: string;
  routineId?: string;
  canManage: boolean;
  onNavigate: (route: AgentsRoute) => void;
  onNewRoutine: () => Promise<void>;
  onEditRoutine: (routine: AgentRoutine) => Promise<void>;
}) {
  if (routineId && routineId !== "new") {
    return (
      <RoutineDetail agentId={agentId} routineId={routineId} canManage={canManage} onNavigate={onNavigate} onEditRoutine={onEditRoutine} />
    );
  }
  return <RoutineList agentId={agentId} canManage={canManage} onNavigate={onNavigate} onNewRoutine={onNewRoutine} />;
}

function RoutineList({
  agentId,
  canManage,
  onNavigate,
  onNewRoutine,
}: {
  agentId: string;
  canManage: boolean;
  onNavigate: (routes: AgentsRoute) => void;
  onNewRoutine: () => Promise<void>;
}) {
  // Live: the member socket pushes the routines whenever one is created,
  // changed, scheduled, run or deleted.
  const { rows: routines, error: loadError, retry } = useAgentRoutines(agentId);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

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

  const work = import.meta.env.MODE !== "control";
  const create = canManage && (
    <Button variant={work ? "ghost" : "default"} size={work ? "icon" : "sm"}
      aria-label={work ? "New scheduled task" : "New routine"} title={work ? "New scheduled task" : undefined}
      onClick={() => void start()} disabled={starting}>
      {starting ? <Loader2 className="animate-spin" /> : <Plus />}
      {!work && "New routine"}
    </Button>
  );

  return (
    <>
      {work && <PageHeader variant="work" title="Scheduled tasks" actions={create || undefined} />}
      <div className={work ? "work-page-content space-y-4 pb-8" : "space-y-4"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {work ? "Create or change scheduled tasks in chat." : "Routines run on a schedule in an isolated context. Ask the agent to create or change one."}
          </p>
          {!work && create}
        </div>
        {error !== null && <ErrorState title="Could not open a routine thread" message={error} />}
        {loadError !== null && <ErrorState title="Could not load routines" message={loadError} onRetry={retry} />}
        {routines === null && loadError === null && <LoadingRows rows={3} />}
        {routines !== null && routines.length === 0 && (
          <EmptyState
            icon={Clock}
            title={work ? "No scheduled tasks yet" : "No routines yet"}
            hint={canManage ? "Start a chat with the agent and describe what should run, when, and in which timezone." : undefined}
          />
        )}
        {routines !== null && routines.length > 0 && (
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
                    {routine.next_run_at ? ` · next ${nextRunLabel(routine.next_run_at)}` : ""}
                  </span>
                </span>
                {routine.last_run && <RunStatusBadge status={routine.last_run.status} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function RoutineDetail({
  agentId,
  routineId,
  canManage,
  onNavigate,
  onEditRoutine,
}: {
  agentId: string;
  routineId: string;
  canManage: boolean;
  onNavigate: (routes: AgentsRoute) => void;
  onEditRoutine: (routine: AgentRoutine) => Promise<void>;
}) {
  // The routine comes from the agent's pushed routines; its run history is
  // seeded once and then follows every pushed run of this routine.
  const { rows: routines, error: loadError, retry } = useAgentRoutines(agentId);
  const routine = routines?.find((row) => row.id === routineId) ?? null;
  const error = loadError ?? (routines !== null && routine === null ? "This routine no longer exists." : null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [changingSchedule, setChangingSchedule] = useState(false);

  useEffect(() => {
    let live = true;
    setRuns(null);
    void listRoutineRuns(agentId, routineId)
      .catch(() => [] as AgentRun[])
      .then((rows) => {
        if (!live) return;
        setRuns((pushed) => (pushed ?? []).reduce((all, run) => upsertRun(all, run), rows));
      });
    return () => {
      live = false;
    };
  }, [agentId, routineId]);

  useAgentRunUpdates((run) => {
    if (run.routine_id !== routineId) return;
    setRuns((rows) => upsertRun(rows ?? [], run));
  });

  const runNow = async () => {
    setRunning(true);
    setActionError(null);
    try {
      await runRoutine(agentId, routineId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start the routine.");
    } finally {
      setRunning(false);
    }
  };

  const changeDelivery = async (delivery: AgentRoutine["delivery"]) => {
    setActionError(null);
    try {
      await updateRoutine(agentId, routineId, { delivery });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not change where the routine delivers.");
    }
  };

  const toggleSchedule = async () => {
    if (!routine) return;
    setChangingSchedule(true);
    setActionError(null);
    try {
      await updateRoutine(agentId, routineId, { enabled: !routine.enabled });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not change the routine status.");
    } finally {
      setChangingSchedule(false);
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

  const work = import.meta.env.MODE !== "control";
  const destinations = { label: work ? "Scheduled tasks" : "Routines", onClick: () => onNavigate({ view: "agent", agentId, tab: "routines" }) } as const;
  const header = (
    <PageHeader variant={work ? "work" : "bar"} title={routine?.name ?? destinations.label} back={destinations} />
  );

  if (error !== null || routine === null) {
    return (
      <>
        {header}
        <div className={work ? "work-page-content pt-3" : "pt-3"}>
          {error !== null
            ? <ErrorState message={error} onRetry={loadError !== null ? retry : undefined} />
            : <LoadingRows rows={3} />}
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className={work ? "work-page-content space-y-6 pb-8 pt-3" : "space-y-6 py-3"}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <dt className="text-muted-foreground">Schedule</dt>
              <dd className="mt-1 flex flex-wrap items-center gap-2" title={routine.schedule ?? undefined}>
                {scheduleLabel(routine)}
                <ToneBadge tone={routine.enabled ? "success" : "neutral"}>
                  {routine.enabled ? "Enabled" : "Paused"}
                </ToneBadge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Next run</dt>
              <dd className="mt-1">{routine.next_run_at ? nextRunLabel(routine.next_run_at) : "Not scheduled"}</dd>
            </div>
          </dl>
          {canManage && (
            <div className="flex items-center gap-1">
              <Button variant="outline" onClick={() => void runNow()} disabled={running}>
                {running ? <Loader2 className="animate-spin" /> : <Play />}
                Run now
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={work ? "Scheduled task actions" : "Routine actions"} title={work ? "Scheduled task actions" : "Routine actions"}>
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void edit()} disabled={editing}>
                    <Pencil /> Edit in chat
                  </DropdownMenuItem>
                  {routine.kind === "cron" && (
                    <DropdownMenuItem onSelect={() => void toggleSchedule()} disabled={changingSchedule}>
                      {routine.enabled ? "Pause schedule" : "Resume schedule"}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label htmlFor="routine-delivery" className="text-muted-foreground">Messages go to</label>
          <Select value={routine.delivery} disabled={!canManage}
            onValueChange={(value) => void changeDelivery(value as AgentRoutine["delivery"])}>
            <SelectTrigger id="routine-delivery" className="w-fit max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">{work ? "One chat for this task" : "One chat for this routine"}</SelectItem>
              <SelectItem value="new_chat">A new chat for each message</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {actionError !== null && <p role="alert" className="text-destructive">{actionError}</p>}

        <section aria-label="Run history" className="space-y-2 border-t border-border pt-4">
          <h2 className="font-semibold">Run history</h2>
          {runs === null ? (
            <LoadingRows rows={2} />
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{work ? "This task has not run yet." : "This routine has not run yet."}</p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                  <RunStatusBadge status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {run.summary?.trim() || "No summary"}
                  </span>
                  {!work && <Mono>{run.id.slice(0, 8)}</Mono>}
                  <span className="text-muted-foreground">{relativeTime(run.started_at ?? run.created_at)}</span>
                  {!work && (
                    <button type="button" className="text-primary underline-offset-4 hover:underline"
                      onClick={() => onNavigate({ view: "run", runId: run.id })}>
                      Open
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="group border-y border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-3 font-semibold [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
            Prompt
          </summary>
          <p className="whitespace-pre-wrap break-words pb-4 leading-relaxed text-muted-foreground">{routine.prompt}</p>
        </details>
      </div>
    </>
  );
}
