import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Clock,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Wrench,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@guild/ui/components/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { Input } from "@guild/ui/components/input";
import { Textarea } from "@guild/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { listModels, modelLabel, type ModelOption } from "../../transport";
import { relativeTime } from "../../lib/relative-time";
import {
  archiveAgent,
  createAgentThread,
  deleteAgent,
  exportAgent,
  getAgent,
  groupTools,
  listAgentTools,
  listAgentRuns,
  listAgentThreads,
  listAgents,
  listMyTeams,
  restoreAgent,
  sendAgentTurn,
  updateAgent,
  type Agent,
  type AgentRoutine,
  type AgentRun,
  type AgentThread,
  type AgentToolInfo,
  type TeamOption,
} from "./agents-api";
import {
  AGENT_TABS,
  VISIBILITY_LABEL,
  type AgentTab,
  type AgentVisibility,
  type AgentsRoute,
} from "./agents-route";
import {
  AgentGlyph,
  AgentStatusBadge,
  ErrorState,
  InlineLoading,
  Mono,
  PageBody,
  PageHeader,
  RunStatusBadge,
  Section,
  TabBar,
  ToneBadge,
  VisibilityBadge,
} from "./agent-ui";
import { ActivityPage } from "./ActivityPage";
import { AgentFiles } from "./AgentFiles";
import { AgentRoutines, humanSchedule } from "./AgentRoutines";
import { ModelName } from "./agent-model";
import { AgentThreadView, ThreadList } from "./AgentThreadView";

export interface Viewer {
  email: string;
  displayName?: string | null;
  role: string;
}

export function canManageAgent(agent: Agent, viewer: Viewer): boolean {
  if (viewer.role === "admin" || viewer.role === "owner") return true;
  const email = viewer.email.toLowerCase();
  return (
    (agent.owner_email ?? "").toLowerCase() === email ||
    (agent.owner_label ?? "").toLowerCase() === email ||
    (viewer.displayName !== undefined &&
      viewer.displayName !== null &&
      (agent.owner_label ?? "") === viewer.displayName)
  );
}

export function AgentPage({
  agentId,
  tab,
  threadId,
  routineId,
  filePath,
  viewer,
  onNavigate,
  onOpenChat,
}: {
  agentId: string;
  tab: AgentTab;
  threadId?: string;
  routineId?: string;
  filePath?: string;
  viewer: Viewer;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void getAgent(agentId)
      .then((row) => {
        if (live) setAgent(row);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setAgent(null);
        setError(err instanceof Error ? err.message : "Could not load this agent.");
      });
    return () => {
      live = false;
    };
  }, [agentId, tick]);

  const manage = agent !== null && canManageAgent(agent, viewer);

  const setTab = (next: AgentTab) => {
    onNavigate({ view: "agent", agentId, tab: next });
  };

  const newThread = async (): Promise<AgentThread | null> => {
    try {
      const row = await createAgentThread(agentId);
      onNavigate({ view: "agent", agentId, tab: "threads", threadId: row.id });
      return row;
    } catch {
      return null;
    }
  };

  /** Routines are written in chat: open a fresh thread and hand the agent the
   *  intent, so the schedule, prompt and later changes all live in the
   *  transcript instead of a form. */
  const startRoutineThread = async (title: string, message: string) => {
    const row = await createAgentThread(agentId, title);
    await sendAgentTurn(agentId, { thread_id: row.id, message });
    onNavigate({ view: "agent", agentId, tab: "threads", threadId: row.id });
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

  if (error !== null) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <PageHeader title="Agent" actions={<Button variant="ghost" size="sm" onClick={() => onNavigate({ view: "directory" })}>Agents</Button>} />
        <PageBody>
          <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
        </PageBody>
      </div>
    );
  }
  if (agent === null) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <PageHeader title="Agent" />
        <PageBody>
          <InlineLoading label="Loading agent" />
        </PageBody>
      </div>
    );
  }

  const refresh = () => setTick((t) => t + 1);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <AgentGlyph name={agent.name} className="size-7 rounded-md text-3xs" />
            <span className="truncate">{agent.name}</span>
            <AgentStatusBadge status={agent.status} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{agent.owner_label ?? "Unknown owner"}</span>
            <span>·</span>
            <VisibilityBadge visibility={agent.visibility} />
            <span>·</span>
            <ModelName id={agent.model} />
            <span>·</span>
            <span>{agent.tools.length} tools</span>
          </span>
        }
        actions={
          <>
            {tab !== "threads" && (
              <Button variant="outline" size="sm" onClick={() => void newThread()}>
                <Plus />
                New thread
              </Button>
            )}
            <AgentActions
              agent={agent}
              manage={manage}
              onChanged={refresh}
              onDeleted={() => onNavigate({ view: "directory" })}
            />
          </>
        }
        tabs={
          <TabBar
            label="Agent sections"
            tabs={AGENT_TABS}
            value={tab}
            onChange={setTab}
          />
        }
      />
      {tab === "threads" && threadId ? (
        <AgentThreadView agent={agent} threadId={threadId} onNavigate={onNavigate} />
      ) : tab === "files" ? (
        <AgentFiles agentId={agent.id} filePath={filePath} onNavigate={onNavigate} />
      ) : (
        <PageBody>
          {tab === "overview" && (
            <AgentOverview agent={agent} onNavigate={onNavigate} onNewThread={newThread} />
          )}
          {tab === "threads" && (
            <ThreadList agent={agent} onNavigate={onNavigate} onNewThread={newThread} />
          )}
          {tab === "routines" && (
            <AgentRoutines
              agentId={agent.id}
              routineId={routineId}
              onNavigate={onNavigate}
              onNewRoutine={newRoutine}
              onEditRoutine={editRoutine}
            />
          )}
          {tab === "activity" && (
            <ActivityPage
              embedded
              agentId={agent.id}
              onNavigate={onNavigate}
              onOpenChat={onOpenChat}
            />
          )}
          {tab === "settings" && (
            <AgentSettings
              agent={agent}
              manage={manage}
              viewer={viewer}
              onChanged={refresh}
              onDeleted={() => onNavigate({ view: "directory" })}
            />
          )}
        </PageBody>
      )}
    </div>
  );
}

function AgentActions({
  agent,
  manage,
  onChanged,
  onDeleted,
}: {
  agent: Agent;
  manage: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const archived = agent.status === "archived" || agent.status === "deleting";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await deleteAgent(agent.id);
      onDeleted();
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setExporting(true);
    try {
      const bundle = await exportAgent(agent.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${agent.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}-export.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Agent actions" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {manage && (
          <>
            {archived ? (
              <DropdownMenuItem onSelect={() => void act(() => restoreAgent(agent.id))}>
                <ArchiveRestore className="size-4" />
                Restore agent
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => void act(() => archiveAgent(agent.id))}>
                <Archive className="size-4" />
                Archive agent
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void download()} disabled={exporting}>
              <Download className="size-4" />
              {exporting ? "Preparing export…" : "Export data"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => setConfirmOpen(true)}
            >
              <Trash2 className="size-4" />
              Delete agent
            </DropdownMenuItem>
          </>
        )}
        {!manage && <DropdownMenuItem disabled>Owner or admin only</DropdownMenuItem>}
      </DropdownMenuContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent stops now and disappears from the directory. Its workspace, threads and
              runs stay recoverable during the organization&apos;s grace period (30 days by
              default); after that they are purged. Download an export first if you need the
              definitions and run history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="outline" onClick={() => void download()} disabled={exporting}>
              <Download />
              {exporting ? "Preparing…" : "Download export"}
            </Button>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void remove()}
            >
              Delete agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DropdownMenu>
  );
}

function AgentOverview({
  agent,
  onNavigate,
  onNewThread,
}: {
  agent: Agent;
  onNavigate: (route: AgentsRoute) => void;
  onNewThread: () => Promise<AgentThread | null>;
}) {
  const [threads, setThreads] = useState<AgentThread[] | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  useEffect(() => {
    void listAgentThreads(agent.id).then(setThreads).catch(() => setThreads([]));
    void listAgentRuns(agent.id).then(setRuns).catch(() => setRuns([]));
  }, [agent.id]);
  const recent = (threads ?? []).slice(0, 3);
  const recentRuns = [...(runs ?? [])]
    .sort(
      (a, b) =>
        Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at),
    )
    .slice(0, 4);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Section
          title="Instructions"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "settings" })}
            >
              <Pencil />
              Edit
            </Button>
          }
        >
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {agent.instructions || "No instructions yet."}
          </p>
        </Section>

        <Section title="Recent threads" description="The default thread is pinned first.">
          {threads === null ? (
            <InlineLoading label="Loading threads" />
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No threads yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() =>
                      onNavigate({
                        view: "agent",
                        agentId: agent.id,
                        tab: "threads",
                        threadId: thread.id,
                      })
                    }
                    className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-foreground"
                  >
                    <MessageSquare className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                    {thread.kind === "default" && <ToneBadge tone="info">Default</ToneBadge>}
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(thread.last_activity_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void onNewThread()}>
              <Plus />
              New thread
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "threads" })}
            >
              All threads
              <ArrowRight />
            </Button>
          </div>
        </Section>
      </div>

      <div className="space-y-4">
        <Section
          title="Recent activity"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "activity" })}
            >
              All activity
              <ArrowRight />
            </Button>
          }
        >
          {runs === null ? (
            <InlineLoading label="Loading activity" />
          ) : recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {recentRuns.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate({ view: "run", runId: run.id })}
                    className="flex w-full items-center gap-2 py-2 text-left text-sm"
                  >
                    <RunStatusBadge status={run.status} />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {run.summary?.trim() || "No summary"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(run.started_at ?? run.created_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Configuration">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Model</dt>
              <dd className="truncate text-xs">
                <ModelName id={agent.model} />
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Visibility</dt>
              <dd>{VISIBILITY_LABEL[agent.visibility]}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Owner</dt>
              <dd className="truncate">{agent.owner_label ?? "Unknown"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Created</dt>
              <dd>{relativeTime(agent.created_at)}</dd>
            </div>
          </dl>
        </Section>

        <Section
          title="Tools"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "settings" })}
            >
              <Wrench />
              Manage
            </Button>
          }
        >
          {agent.tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tools selected.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {agent.tools.map((tool) => (
                <span
                  key={tool}
                  className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-2xs text-muted-foreground"
                >
                  {tool}
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section title="Workspace">
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "files" })}
            >
              <FileText />
              Browse files
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "routines" })}
            >
              <Clock />
              Routines
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function AgentSettings({
  agent,
  manage,
  viewer,
  onChanged,
  onDeleted,
}: {
  agent: Agent;
  manage: boolean;
  viewer: Viewer;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [model, setModel] = useState(agent.model);
  const [tools, setTools] = useState<string[]>(agent.tools);
  const [toolsMode, setToolsMode] = useState<"selected" | "all">(agent.tools_mode ?? "selected");
  const [visibility, setVisibility] = useState<AgentVisibility>(agent.visibility);
  const [teamIds, setTeamIds] = useState<string[]>(agent.team_ids ?? []);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [catalog, setCatalog] = useState<AgentToolInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const download = async () => {
    setExporting(true);
    try {
      const bundle = await exportAgent(agent.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${agent.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}-export.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    void listModels().then((rows) => setModels(rows ?? []));
    void listMyTeams().then(setTeams).catch(() => setTeams([]));
    void listAgentTools().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  const groups = useMemo(() => groupTools(catalog), [catalog]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateAgent(agent.id, {
        name: name.trim(),
        instructions,
        model,
        tools,
        tools_mode: toolsMode,
        visibility,
        team_ids: visibility === "team" ? teamIds : [],
      });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the agent.");
    } finally {
      setSaving(false);
    }
  };

  if (!manage) {
    return (
      <div className="space-y-4">
        <Section title="Settings">
          <p className="text-sm text-muted-foreground">
            Only the owner or an admin can change this agent.
          </p>
        </Section>
        <ReadOnlyConfig agent={agent} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Section title="Agent configuration">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Name</span>
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Model</span>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(models ?? []).map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {modelLabel(option)}
                  </SelectItem>
                ))}
                {models !== null && !models.some((m) => m.id === model) && (
                  <SelectItem value={model}>{model}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className="mt-3 block space-y-1.5">
          <span className="text-xs font-medium">Instructions</span>
          <Textarea
            value={instructions}
            rows={10}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        <div className="mt-3 space-y-1.5">
          <span className="text-xs font-medium">Visibility</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["private", "team", "org"] as AgentVisibility[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setVisibility(value)}
                className={`rounded-lg border px-3 py-2 text-left text-xs outline-none transition-colors ${
                  visibility === value
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <span className="block font-medium">{VISIBILITY_LABEL[value]}</span>
                <span className="block text-muted-foreground">
                  {value === "private"
                    ? "Only the owner."
                    : value === "team"
                      ? "Selected teams."
                      : "Every member."}
                </span>
              </button>
            ))}
          </div>
          {visibility === "team" && (
            <div className="mt-2 space-y-2 rounded-lg border border-border p-3">
              <p className="text-xs font-medium">Teams</p>
              {teams.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  You are not a member of any team yet.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {teams.map((team) => {
                    const checked = teamIds.includes(team.id);
                    return (
                      <label
                        key={team.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setTeamIds((current) =>
                              checked
                                ? current.filter((id) => id !== team.id)
                                : [...current, team.id],
                            )
                          }
                        />
                        <span className="truncate">{team.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section
        title="Tools"
        description={toolsMode === "all" ? "All available tools" : `${tools.length} selected`}
        action={
          toolsMode === "selected" && catalog.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTools(catalog.map((t) => t.name))}
            >
              Select all tools
            </Button>
          ) : undefined
        }
      >
        <div className="mb-3 space-y-1.5">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2">
            <input
              type="radio"
              name="tools-mode"
              className="mt-0.5 size-4 accent-foreground"
              checked={toolsMode === "all"}
              onChange={() => setToolsMode("all")}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">All available tools</span>
              <span className="block text-xs text-muted-foreground">
                Includes every integration the org enables now and later, without editing this agent.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2">
            <input
              type="radio"
              name="tools-mode"
              className="mt-0.5 size-4 accent-foreground"
              checked={toolsMode === "selected"}
              onChange={() => setToolsMode("selected")}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Choose tools</span>
              <span className="block text-xs text-muted-foreground">
                Only the tools selected below.
              </span>
            </span>
          </label>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Codemode is always available. Integration tools appear here when the org
          enables that integration.
        </p>
        {toolsMode === "all" ? (
          <p className="text-sm text-muted-foreground">
            This agent uses every tool the org enables, including integrations added later.
          </p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The org tool catalog did not load. The current allowlist is shown below.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.group} className="space-y-1.5">
                <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.group}
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {group.tools.map((tool) => {
                    const checked = tools.includes(tool.name);
                    return (
                      <label
                        key={tool.name}
                        className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${
                          checked ? "border-ring bg-accent/60" : "border-border"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 accent-foreground"
                          checked={checked}
                          onChange={() =>
                            setTools((current) =>
                              current.includes(tool.name)
                                ? current.filter((n) => n !== tool.name)
                                : [...current, tool.name],
                            )
                          }
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">
                            {tool.label || tool.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {tool.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {groups.length === 0 && tools.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tools.map((tool) => (
              <span
                key={tool}
                className="rounded-md border border-border px-2 py-0.5 font-mono text-2xs"
              >
                {tool}
              </span>
            ))}
          </div>
        )}
      </Section>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-xs text-muted-foreground">Saved.</span>}
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
      </div>

      <Section
        title="Danger zone"
        description={`Deleting starts a grace period. The default is 30 days; the org can change it.`}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (agent.status === "active") await archiveAgent(agent.id);
              else await restoreAgent(agent.id);
              onChanged();
            }}
          >
            {agent.status === "active" ? <Archive /> : <ArchiveRestore />}
            {agent.status === "active" ? "Archive agent" : "Restore agent"}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
            <Trash2 />
            Delete agent
          </Button>
        </div>
        {agent.status === "deleting" && agent.purge_after && (
          <p className="mt-2 text-xs text-muted-foreground">
            Purge is scheduled after {new Date(agent.purge_after).toLocaleString()}.
          </p>
        )}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The agent stops now and disappears from the directory. Its workspace, threads and
                runs stay recoverable during the organization&apos;s grace period (30 days by
                default); after that they are purged. Download an export first if you need the
                definitions and run history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button variant="outline" onClick={() => void download()} disabled={exporting}>
                <Download />
                {exporting ? "Preparing…" : "Download export"}
              </Button>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  void deleteAgent(agent.id).then(onDeleted);
                }}
              >
                Delete agent
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <p className="mt-2 text-xs text-muted-foreground">
          Signed in as {viewer.email}. Owner and admin actions are audited.
        </p>
      </Section>
    </div>
  );
}

function ReadOnlyConfig({ agent }: { agent: Agent }) {
  return (
    <Section title="Configuration">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{agent.name}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Model</dt>
          <dd className="text-xs">
            <ModelName id={agent.model} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Visibility</dt>
          <dd>{VISIBILITY_LABEL[agent.visibility]}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Instructions</dt>
          <dd className="mt-1 whitespace-pre-wrap">{agent.instructions}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tools</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {agent.tools.map((tool) => (
              <Mono key={tool}>{tool}</Mono>
            ))}
          </dd>
        </div>
      </dl>
    </Section>
  );
}

/** Directory data for callers that need an agent's display name. */
export async function agentNameOf(id: string): Promise<string> {
  try {
    const agents = await listAgents();
    return agents.find((a) => a.id === id)?.name ?? "Agent";
  } catch {
    return "Agent";
  }
}
