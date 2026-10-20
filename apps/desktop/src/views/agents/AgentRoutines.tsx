import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Clock,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Textarea } from "@guild/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { relativeTime } from "../../lib/relative-time";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutineRuns,
  listRoutines,
  runRoutine,
  updateRoutine,
  type AgentRoutine,
  type AgentRun,
  type RoutineInput,
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

const TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function scheduleLabel(routine: AgentRoutine): string {
  if (routine.kind === "once")
    return routine.run_at ? `Once at ${new Date(routine.run_at).toLocaleString()}` : "Once";
  return `${routine.schedule} · ${routine.timezone}`;
}

export function AgentRoutines({
  agentId,
  routineId,
  onNavigate,
}: {
  agentId: string;
  routineId?: string;
  onNavigate: (route: AgentsRoute) => void;
}) {
  if (routineId) {
    return (
      <RoutineDetail
        agentId={agentId}
        routineId={routineId}
        onNavigate={onNavigate}
      />
    );
  }
  return <RoutineList agentId={agentId} onNavigate={onNavigate} />;
}

function RoutineList({
  agentId,
  onNavigate,
}: {
  agentId: string;
  onNavigate: (routes: AgentsRoute) => void;
}) {
  const [routines, setRoutines] = useState<AgentRoutine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] text-muted-foreground">
          Scheduled prompts run in an isolated context. Reminders are one-shot routines.
        </p>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw />
          Refresh
        </Button>
        <Button
          size="sm"
          onClick={() => onNavigate({ view: "agent", agentId, tab: "routines", routineId: "new" })}
        >
          <Plus />
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
          body="Add a cron schedule or a one-shot reminder. The agent runs it without a thread."
          action={
            <Button
              size="sm"
              onClick={() =>
                onNavigate({ view: "agent", agentId, tab: "routines", routineId: "new" })
              }
            >
              <Plus />
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
                  <span className="truncate text-[13.5px] font-medium">{routine.name}</span>
                  <ToneBadge tone={routine.enabled ? "success" : "neutral"}>
                    {routine.enabled ? "Enabled" : "Paused"}
                  </ToneBadge>
                  {routine.kind === "once" && <ToneBadge tone="info">Reminder</ToneBadge>}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                  {scheduleLabel(routine)}
                  {routine.next_run_at
                    ? ` · next ${relativeTime(routine.next_run_at)}`
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

function emptyRoutine(): RoutineInput {
  return {
    name: "",
    kind: "cron",
    schedule: "0 9 * * 1-5",
    timezone: defaultTimezone(),
    run_at: null,
    prompt: "",
    enabled: true,
  };
}

function RoutineDetail({
  agentId,
  routineId,
  onNavigate,
}: {
  agentId: string;
  routineId: string;
  onNavigate: (routes: AgentsRoute) => void;
}) {
  const creating = routineId === "new";
  const [routine, setRoutine] = useState<AgentRoutine | null>(null);
  const [form, setForm] = useState<RoutineInput>(emptyRoutine());
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (creating) return;
    let live = true;
    setError(null);
    void getRoutine(agentId, routineId)
      .then((row) => {
        if (!live) return;
        setRoutine(row);
        setForm({
          name: row.name,
          kind: row.kind,
          schedule: row.schedule,
          timezone: row.timezone,
          run_at: row.run_at ?? null,
          prompt: row.prompt,
          enabled: row.enabled,
        });
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
  }, [agentId, routineId, creating, tick]);

  const save = async () => {
    if (form.name.trim() === "" || form.prompt.trim() === "") {
      setSaveError("Name and prompt are required.");
      return;
    }
    if (form.kind === "cron" && form.schedule.trim() === "") {
      setSaveError("Enter a cron schedule.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = creating
        ? await createRoutine(agentId, form)
        : await updateRoutine(agentId, routineId, form);
      setRoutine(saved);
      onNavigate({ view: "agent", agentId, tab: "routines", routineId: saved.id });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the routine.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Delete this routine? Its run history stays in Activity.")) return;
    try {
      await deleteRoutine(agentId, routineId);
      onNavigate({ view: "agent", agentId, tab: "routines" });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not delete the routine.");
    }
  };

  const runNow = async () => {
    setRunning(true);
    setSaveError(null);
    try {
      await runRoutine(agentId, routineId);
      setTick((t) => t + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not start the routine.");
    } finally {
      setRunning(false);
    }
  };

  if (!creating && error !== null) {
    return (
      <div className="space-y-4">
        <BackButton onNavigate={onNavigate} agentId={agentId} />
        <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
      </div>
    );
  }
  if (!creating && routine === null) return <InlineLoading label="Loading routine" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <BackButton onNavigate={onNavigate} agentId={agentId} />
        <div className="flex-1" />
        {!creating && (
          <>
            <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={running}>
              {running ? <Loader2 className="animate-spin" /> : <Play />}
              Run now
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void remove()}>
              <Trash2 />
              Delete
            </Button>
          </>
        )}
      </div>

      <Section title={creating ? "New routine" : "Routine configuration"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-[12.5px] font-medium">Name</span>
            <Input
              value={form.name}
              placeholder="Weekday research digest"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-[12.5px] font-medium">Kind</span>
            <Select
              value={form.kind}
              onValueChange={(value) =>
                setForm({ ...form, kind: value as RoutineInput["kind"] })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Cron schedule</SelectItem>
                <SelectItem value="once">One-shot reminder</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {form.kind === "cron" ? (
            <>
              <label className="space-y-1.5">
                <span className="text-[12.5px] font-medium">Cron schedule</span>
                <Input
                  value={form.schedule}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                  onChange={(e) => setForm({ ...form, schedule: e.target.value })}
                />
                <span className="block text-[11.5px] text-muted-foreground">
                  Five fields: minute hour day month weekday. Minimum interval is one minute.
                </span>
              </label>
              <label className="space-y-1.5">
                <span className="text-[12.5px] font-medium">Timezone</span>
                <Select
                  value={form.timezone}
                  onValueChange={(value) => setForm({ ...form, timezone: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([form.timezone, ...TIMEZONES])].filter(Boolean).map((zone) => (
                      <SelectItem key={zone} value={zone}>
                        {zone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </>
          ) : (
            <label className="space-y-1.5">
              <span className="text-[12.5px] font-medium">Run at</span>
              <Input
                type="datetime-local"
                value={form.run_at ? form.run_at.slice(0, 16) : ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    run_at: e.target.value ? new Date(e.target.value).toISOString() : null,
                  })
                }
              />
            </label>
          )}
          <label className="flex items-center gap-2 pt-6 text-[12.5px]">
            <input
              type="checkbox"
              className="size-4 accent-foreground"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
        <label className="mt-3 block space-y-1.5">
          <span className="text-[12.5px] font-medium">Prompt</span>
          <Textarea
            value={form.prompt}
            rows={6}
            placeholder="Review memories/ for open questions. Search recent threads and send one short digest."
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
          <span className="block text-[11.5px] text-muted-foreground">
            The run gets these instructions, this prompt and the workspace. It does not see the default thread.
          </span>
        </label>
        {saveError !== null && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {saveError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate({ view: "agent", agentId, tab: "routines" })}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {creating ? "Create routine" : "Save changes"}
          </Button>
        </div>
      </Section>

      {!creating && (
        <Section title="Run history" description="Occurrences of this routine, newest first.">
          {runs === null ? (
            <InlineLoading label="Loading runs" />
          ) : runs.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">This routine has not run yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
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
      )}
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
