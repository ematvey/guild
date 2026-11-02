import { useMemo, useState } from "react";
import { Bot, Plus, Search, Sparkles } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { relativeTime } from "../../lib/relative-time";
import type { AgentsRoute } from "./agents-route";
import { VISIBILITY_LABEL } from "./agents-route";
import type { Agent } from "./agents-api";
import { useAgentList } from "./agents-store";
import { count } from "../../lib/format";
import { ModelName } from "./agent-model";
import {
  AgentGlyph,
  AgentStatusBadge,
  LoadingRows,
  PageBody,
  PageHeader,
} from "./agent-ui";
import { EmptyState } from "@guild/ui/components/empty-state";

export function filterAgents(agents: Agent[], query: string): Agent[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return agents;
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(needle) ||
      (agent.description ?? "").toLowerCase().includes(needle) ||
      (agent.owner_label ?? "").toLowerCase().includes(needle) ||
      agent.model.toLowerCase().includes(needle) ||
      agent.visibility.includes(needle),
  );
}

/** Most recently updated first, archived last. */
export function sortAgents(agents: Agent[]): Agent[] {
  const rank = (a: Agent) => (a.status === "active" ? 0 : 1);
  return [...agents].sort((a, b) => {
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    const at = Date.parse(a.updated_at);
    const bt = Date.parse(b.updated_at);
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });
}

export function AgentsDirectory({
  onNavigate,
}: {
  onNavigate: (route: AgentsRoute) => void;
}) {
  // Every agent this member may see, archived ones included: the member
  // socket pushes the list on connect and on every agent change.
  const agents = useAgentList();
  const [query, setQuery] = useState("");

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
        {agents === null && <LoadingRows rows={5} />}
        {agents !== null && visible.length === 0 && (
          <EmptyState
            icon={Bot}
            title={query.trim() === "" ? "No agents yet" : `No agents match "${query.trim()}"`}
            hint={
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
        {agents !== null && visible.length > 0 && (
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
      <h2 className="mb-1.5 px-3 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-card/40">
        {agents.map((agent) => (
          <li key={agent.id}>
            <AgentRow agent={agent} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One agent as a full-width record. The row carries the name, owner,
 * description and its facts on a single line of meta text; only the
 * exceptional state (not active) gets a badge.
 */
export function AgentRow({
  agent,
  onNavigate,
}: {
  agent: Agent;
  onNavigate: (route: AgentsRoute) => void;
}) {
  const last = agent.updated_at;
  const owner = agent.owner_label ?? "Unknown owner";
  const ownerEmail =
    agent.owner_email && agent.owner_email !== agent.owner_label ? agent.owner_email : null;
  const tools =
    agent.tools_mode === "all"
      ? "All tools"
      : count(agent.tools.length, "tool");
  return (
    <button
      type="button"
      onClick={() => onNavigate({ view: "agent", agentId: agent.id, tab: "overview" })}
      aria-label={`Open agent ${agent.name}`}
      className="flex w-full items-start gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/60"
    >
      <AgentGlyph name={agent.name} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{agent.name}</span>
          {agent.status !== "active" && <AgentStatusBadge status={agent.status} />}
        </div>
        <p className="mt-0.5 truncate text-2xs text-muted-foreground">
          {owner}
          {ownerEmail !== null ? ` · ${ownerEmail}` : ""}
        </p>
        {agent.description && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {agent.description}
          </p>
        )}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-muted-foreground">
          <span>{VISIBILITY_LABEL[agent.visibility]}</span>
          <Separator />
          <span className="min-w-0 truncate">
            <ModelName id={agent.model} alias={agent.model_alias} />
          </span>
          <Separator />
          <span>{tools}</span>
        </p>
      </div>
      <span className="shrink-0 pt-0.5 text-2xs text-muted-foreground" title={last}>
        {relativeTime(last)}
      </span>
    </button>
  );
}

function Separator() {
  return (
    <span aria-hidden="true" className="text-border">
      ·
    </span>
  );
}

