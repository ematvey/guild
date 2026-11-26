// The Access tab of an installed integration: its audience (every member, the
// chosen teams, or admins only) and the highest class each may give an agent,
// plus every agent that lists it, with the warnings where an agent reaches
// people outside that audience. The audience is an admin editing form, read
// when opened and after the admin's own save; the agent list and its
// warnings are the live `agent_list` frame.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { AgentIntegration } from "@guild/wire/rest";
import { Button } from "@guild/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { useCachedGet } from "../../../desktop/src/views/settings/use-cached-api";
import { useAgentList } from "../../../desktop/src/views/agents/agents-store";
import { CLASS_LABEL, IntegrationWarnings } from "../agents/agent-integrations";
import {
  agentAccessLabel,
  agentTabRoute,
  agentsRoutePath,
} from "../../../desktop/src/views/agents/agents-route";
import {
  integrationAccessPath,
  putIntegrationAccess,
  type AccessAudience,
  type IntegrationAccess,
} from "./integrations-api";

type GrantCeiling = "read" | "write";

const AUDIENCES: [AccessAudience, string, string][] = [
  ["admins", "Admins only", "Only admins can add it to an agent."],
  ["team", "Chosen teams", "Members of the teams below can add it."],
  ["org", "Every member", "Any member can add it to an agent they manage."],
];

function CeilingSelect({
  value,
  onChange,
  label,
}: {
  value: GrantCeiling;
  onChange: (next: GrantCeiling) => void;
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as GrantCeiling)}
    >
      <SelectTrigger className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="read">{CLASS_LABEL.read}</SelectItem>
        <SelectItem value="write">{CLASS_LABEL.write}</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function AccessTab({
  id,
  slug,
  title,
  onOpenAgent,
}: {
  id: string;
  slug: string;
  title: string;
  onOpenAgent: (agentId: string) => void;
}) {
  const res = useCachedGet<IntegrationAccess>(integrationAccessPath(id));
  const data = res.data;
  const [audience, setAudience] = useState<AccessAudience>("admins");
  const [orgCeiling, setOrgCeiling] = useState<GrantCeiling>("read");
  const [grants, setGrants] = useState<Record<string, GrantCeiling>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data === null) return;
    setAudience(data.audience);
    setOrgCeiling(data.org_ceiling);
    setGrants(
      Object.fromEntries(
        data.grants.map((grant) => [grant.team_id, grant.ceiling]),
      ),
    );
  }, [data]);

  const agents = useAgentList();
  const using = useMemo(
    () =>
      (agents ?? [])
        .filter(
          (agent) =>
            agent.status !== "deleting" &&
            agent.integrations.some((entry) => entry.slug === slug),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agents, slug],
  );

  const save = async () => {
    setSaving(true);
    try {
      await putIntegrationAccess(id, {
        audience,
        org_ceiling: orgCeiling,
        grants: Object.entries(grants).map(([team_id, ceiling]) => ({
          team_id,
          ceiling,
        })),
      });
      toast.success("Access saved", { description: title });
      res.reload();
    } catch (e) {
      toast.error("Could not save access", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  if (data === null) {
    return res.error !== null ? (
      <p className="text-sm text-destructive">{res.error}</p>
    ) : (
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    );
  }

  const warned = using.filter((agent) =>
    agent.integration_warnings.some((w) => w.integration === slug),
  ).length;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold">Who can add it to an agent</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          An agent that lists {title} gives it to everyone who can use that
          agent. The audience decides who may add it, and the highest access
          they may give. Admins can always add it.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {AUDIENCES.map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => setAudience(value)}
              className={`rounded-lg border px-3 py-2 text-left text-xs outline-none transition-colors ${
                audience === value
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <span className="block font-medium">{label}</span>
              <span className="block text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
        {audience === "org" && (
          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm">Members may give up to</span>
            <CeilingSelect
              value={orgCeiling}
              onChange={setOrgCeiling}
              label="Highest access for members"
            />
          </div>
        )}
        {audience === "team" && (
          <div className="mt-4 divide-y divide-border border-y border-border">
            {data.teams.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">
                The organization has no teams yet.
              </p>
            ) : (
              data.teams.map((team) => {
                const granted = grants[team.id];
                return (
                  <div
                    key={team.id}
                    className="flex flex-wrap items-center gap-3 py-2.5"
                  >
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-foreground"
                        checked={granted !== undefined}
                        onChange={() =>
                          setGrants((current) => {
                            const next = { ...current };
                            if (granted === undefined) next[team.id] = "read";
                            else delete next[team.id];
                            return next;
                          })
                        }
                      />
                      <span className="truncate">{team.name}</span>
                    </label>
                    {granted !== undefined && (
                      <CeilingSelect
                        value={granted}
                        onChange={(ceiling) =>
                          setGrants((current) => ({
                            ...current,
                            [team.id]: ceiling,
                          }))
                        }
                        label={`Highest access for ${team.name}`}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={
              saving ||
              (audience === "team" && Object.keys(grants).length === 0)
            }
          >
            {saving && <Loader2 className="animate-spin" />}
            Save access
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Agents that use it</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          {using.length === 0
            ? `No agent lists ${title}.`
            : warned === 0
              ? "Every agent below stays within the audience."
              : `${warned} of ${using.length} reach people outside the audience. Narrow the agent's visibility or remove ${title} from it.`}
        </p>
        {using.length > 0 && (
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {using.map((agent) => {
              const entry = agent.integrations.find(
                (item) => item.slug === slug,
              ) as AgentIntegration;
              return (
                <li key={agent.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <a
                      href={agentsRoutePath(
                        agentTabRoute(agent.id, "settings"),
                      )}
                      onClick={(event) => {
                        if (
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.button !== 0
                        )
                          return;
                        event.preventDefault();
                        onOpenAgent(agent.id);
                      }}
                      className="text-sm font-medium hover:underline"
                    >
                      {agent.name}
                    </a>
                    <span className="text-xs text-muted-foreground">
                      {agent.is_personal ? "Personal" : agentAccessLabel(agent)}
                      {agent.owner_label
                        ? ` · ${agent.owner_label}`
                        : ""} · {CLASS_LABEL[entry.ceiling].toLowerCase()}
                    </span>
                  </div>
                  <IntegrationWarnings
                    warnings={agent.integration_warnings.filter(
                      (w) => w.integration === slug,
                    )}
                    title={title}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
