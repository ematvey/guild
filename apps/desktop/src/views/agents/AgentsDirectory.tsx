import { useEffect, useMemo, useState } from "react";
import { Bot, Plus, Search, Sparkles } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";
import { relativeTime } from "../../lib/relative-time";
import type { AgentsRoute } from "./agents-route";
import { listAgents, type Agent } from "./agents-api";
import { ModelName } from "./agent-model";
import {
  AgentGlyph,
  AgentStatusBadge,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageBody,
  PageHeader,
  VisibilityBadge,
} from "./agent-ui";

export function filterAgents(agents: Agent[], query: string): Agent[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return agents;
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(needle) ||
      (agent.owner_label ?? "").toLowerCase().includes(needle) ||
      agent.model.toLowerCase().includes(needle) ||
      agent.visibility.includes(needle),
  );
}

/** Most recently active first, archived last. */
export function sortAgents(agents: Agent[]): Agent[] {
  const rank = (a: Agent) => (a.status === "active" ? 0 : 1);
  return [...agents].sort((a, b) => {
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    const at = Date.parse(a.last_activity_at ?? a.updated_at ?? a.created_at);
    const bt = Date.parse(b.last_activity_at ?? b.updated_at ?? b.created_at);
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });
}

export function AgentsDirectory({
  onNavigate,
}: {
  onNavigate: (route: AgentsRoute) => void;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void listAgents(true)
      .then((rows) => {
        if (live) setAgents(rows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setAgents(null);
        setError(err instanceof Error ? err.message : "The agents API did not answer.");
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const visible = useMemo(
    () => sortAgents(filterAgents(agents ?? [], query)),
    [agents, query],
  );
  const active = visible.filter((a) => a.status === "active");
  const archived = visible.filter((a) => a.status !== "active");

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title="Agents"
        description="Named teammates with their own workspace, threads and routines."
        actions={
          <>
            <div className="relative w-full sm:w-[260px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                aria-label="Search agents"
                placeholder="Search agents"
                className="pl-8"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={() => onNavigate({ view: "new" })}>
              <Plus />
              Create agent
            </Button>
          </>
        }
      />
      <PageBody>
        {error !== null && (
          <ErrorState
            title="Could not load agents"
            message={error}
            onRetry={() => {
              setAgents(null);
              setTick((t) => t + 1);
            }}
          />
        )}
        {error === null && agents === null && <LoadingRows rows={5} />}
        {error === null && agents !== null && visible.length === 0 && (
          <EmptyState
            icon={<Bot className="size-5" />}
            title={query.trim() === "" ? "No agents yet" : `No agents match "${query.trim()}"`}
            body={
              query.trim() === ""
                ? "Create an agent to give it instructions, tools and a durable workspace."
                : "Try a name, owner, model or visibility."
            }
            action={
              query.trim() === "" ? (
                <Button onClick={() => onNavigate({ view: "new" })}>
                  <Sparkles />
                  Create agent
                </Button>
              ) : undefined
            }
          />
        )}
        {error === null && agents !== null && visible.length > 0 && (
          <div className="space-y-6">
            <AgentGroup
              title="Active"
              agents={active}
              onNavigate={onNavigate}
            />
            {archived.length > 0 && (
              <AgentGroup
                title="Archived and deleting"
                agents={archived}
                onNavigate={onNavigate}
              />
            )}
          </div>
        )}
      </PageBody>
    </div>
  );
}

function AgentGroup({
  title,
  agents,
  onNavigate,
}: {
  title: string;
  agents: Agent[];
  onNavigate: (route: AgentsRoute) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 px-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onNavigate={onNavigate} />
        ))}
      </div>
    </section>
  );
}

function AgentCard({
  agent,
  onNavigate,
}: {
  agent: Agent;
  onNavigate: (route: AgentsRoute) => void;
}) {
  const last = agent.last_activity_at ?? agent.updated_at ?? agent.created_at;
  return (
    <button
      type="button"
      onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "overview" })}
      aria-label={`Open agent ${agent.name}`}
      className="group flex min-h-32 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left outline-none transition-colors hover:border-ring/60 hover:bg-accent/40 focus-visible:border-ring"
    >
      <div className="flex items-start gap-3">
        <AgentGlyph name={agent.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{agent.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {agent.owner_label ?? "Unknown owner"}
            {agent.owner_email && agent.owner_email !== agent.owner_label
              ? ` · ${agent.owner_email}`
              : ""}
          </p>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <VisibilityBadge visibility={agent.visibility} />
        <span className="max-w-full truncate rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-muted-foreground">
          <ModelName id={agent.model} alias={agent.model_alias} />
        </span>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {agent.tools_mode === "all"
            ? "All tools"
            : `${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"}`}
        </span>
        <span title={last}>{relativeTime(last)}</span>
      </div>
    </button>
  );
}

/** Skeleton header used by the agent page while its row loads. */
export function AgentHeaderSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-9 rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
    </div>
  );
}
