import {
  ArrowRight,
  Clock,
  FileText,
  MessageSquare,
  Pencil,
  Plus,
  Wrench,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { relativeTime } from "../../lib/relative-time";
import { count } from "../../lib/format";
import {
  createAgentThread,
  sendAgentTurn,
  type Agent,
  type AgentRoutine,
  type AgentThread,
} from "./agents-api";
import {
  AGENT_TABS,
  DEFAULT_ACTIVITY_FILTERS,
  VISIBILITY_LABEL,
  type ActivityFilters,
  type AgentTab,
  type AgentsRoute,
} from "./agents-route";
import {
  AgentGlyph,
  AgentStatusBadge,
  ErrorState,
  InlineLoading,
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
import { ThreadList } from "./AgentThreadList";
import { AgentActions, AgentSettings } from "./agent-settings";
import { useAgentList, useAgentRuns, useAgentThreads } from "./agents-store";

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
  filters,
  viewer,
  onNavigate,
  onOpenChat,
}: {
  agentId: string;
  tab: AgentTab;
  threadId?: string;
  routineId?: string;
  filePath?: string;
  filters?: ActivityFilters;
  viewer: Viewer;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
}) {
  // The agent row is live: the pushed agent list carries every agent this
  // member may see, so an edit, archive or visibility change repaints here.
  const agents = useAgentList();
  const agent = agents?.find((row) => row.id === agentId) ?? null;
  const error = agents !== null && agent === null ? "This agent does not exist or is not shared with you." : null;

  const manage = agent !== null && canManageAgent(agent, viewer);

  const setTab = (next: AgentTab) => {
    onNavigate(
      next === "activity"
        ? { view: "agent", agentId, tab: next, filters: DEFAULT_ACTIVITY_FILTERS }
        : { view: "agent", agentId, tab: next },
    );
  };

  /** A thread has one canonical address: its chat. */
  const openThread = (thread: { id: string; chat_id: string }) => {
    if (onOpenChat) onOpenChat(thread.chat_id);
    else onNavigate({ view: "agent", agentId, tab: "threads" });
  };

  const newThread = async (): Promise<AgentThread | null> => {
    try {
      const row = await createAgentThread(agentId);
      openThread(row);
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
    openThread(row);
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
          <ErrorState message={error} />
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
            <ModelName id={agent.model} alias={agent.model_alias} />
            <span>·</span>
            <span>{count(agent.tools.length, "tool")}</span>
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
              onDeleted={() => onNavigate({ view: "directory" })}
            />
          </>
        }
        tabs={
          <TabBar
            label="Agent sections"
            tabs={
              viewer.role === "admin"
                ? AGENT_TABS
                : AGENT_TABS.filter(([id]) => id !== "activity")
            }
            value={tab}
            onChange={setTab}
          />
        }
      />
      {tab === "threads" && threadId ? (
        <ThreadList
          agent={agent}
          onNavigate={onNavigate}
          onNewThread={newThread}
          onOpenChat={onOpenChat}
        />
      ) : tab === "files" ? (
        <AgentFiles
          agentId={agent.id}
          filePath={filePath}
          onNavigate={onNavigate}
          onOpenChat={onOpenChat}
        />
      ) : (
        <PageBody>
          {tab === "overview" && (
            <AgentOverview
              agent={agent}
              onNavigate={onNavigate}
              onNewThread={newThread}
              onOpenChat={onOpenChat}
            />
          )}
          {tab === "threads" && (
            <ThreadList
              agent={agent}
              onNavigate={onNavigate}
              onNewThread={newThread}
              onOpenChat={onOpenChat}
            />
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
              role={viewer.role}
              agentId={agent.id}
              filters={filters ?? DEFAULT_ACTIVITY_FILTERS}
              onFiltersChange={(next) =>
                onNavigate({ view: "agent", agentId, tab: "activity", filters: next })
              }
              onNavigate={onNavigate}
              onOpenChat={onOpenChat}
            />
          )}
          {tab === "settings" && (
            <AgentSettings
              agent={agent}
              manage={manage}
              viewer={viewer}
              onDeleted={() => onNavigate({ view: "directory" })}
            />
          )}
        </PageBody>
      )}
    </div>
  );
}

function AgentOverview({
  agent,
  onNavigate,
  onNewThread,
  onOpenChat,
}: {
  agent: Agent;
  onNavigate: (route: AgentsRoute) => void;
  onNewThread: () => Promise<AgentThread | null>;
  onOpenChat?: (chatId: string) => void;
}) {
  const threads = useAgentThreads(agent.id);
  const runs = useAgentRuns(agent.id);
  const recent = (threads ?? []).slice(0, 3);
  const recentRuns = [...(runs ?? [])]
    .sort(
      (a, b) =>
        Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at),
    )
    .slice(0, 4);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {agent.description ? (
          <Section title="About">
            <p className="text-sm text-muted-foreground">{agent.description}</p>
          </Section>
        ) : null}
        <Section
          title="Configuration files"
          description="AGENTS.md and MEMORY.md live in the workspace and load into every thread."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "files" })}
            >
              <Pencil />
              Edit files
            </Button>
          }
        >
          <p className="text-sm leading-relaxed text-muted-foreground">
            The agent reads these files at the start of each thread and can edit them itself. Changes apply on the
            next turn.
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
                      onOpenChat
                        ? onOpenChat(thread.chat_id)
                        : onNavigate({ view: "agent", agentId: agent.id, tab: "threads" })
                    }
                    className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-foreground"
                  >
                    <MessageSquare className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                    {thread.is_default && <ToneBadge tone="info">Default</ToneBadge>}
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
                <ModelName id={agent.model} alias={agent.model_alias} />
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
