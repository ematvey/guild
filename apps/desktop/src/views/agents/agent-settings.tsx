// The agent's Settings tab: the editable configuration for managers, the
// read-only configuration for everyone else.

import { useEffect, useMemo, useState } from "react";
import type { Viewer } from "./AgentPage";
import { Archive, ArchiveRestore, Download, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { modelLabel } from "../../lib/api/models";
import {
  archiveAgent,
  deleteAgent,
  exportAgent,
  groupTools,
  listAgentTools,
  openAssistant,
  restoreAgent,
  updateAgent,
  type Agent,
  type AgentToolInfo,
} from "./agents-api";
import { AccessPanel } from "../access/AccessPanel";
import { Mono, Section } from "./agent-ui";
import { ModelName, useModelOptions } from "./agent-model";
import { AgentIntegrationsEditor, CLASS_LABEL, IntegrationWarnings } from "./agent-integrations";
import { useAttachableIntegrations } from "./agents-store";
import type { AgentIntegration } from "@guild/wire/rest";

export function AgentSettings({
  agent,
  manage,
  viewer,
  onDeleted,
  onOpenChat,
}: {
  agent: Agent;
  manage: boolean;
  viewer: Viewer;
  onDeleted: () => void;
  onOpenChat?: (chatId: string) => void;
}) {
  const agentResources = (
    agent.resources && typeof agent.resources === "object" && !Array.isArray(agent.resources) ? agent.resources : {}
  ) as Record<string, unknown>;
  const rawAssistant = agentResources["assistant"];
  const initialAssistant =
    rawAssistant && typeof rawAssistant === "object" ? (rawAssistant as Record<string, unknown>) : {};
  const [assistant, setAssistant] = useState<Record<string, unknown>>(initialAssistant);
  const assistantEnabled = typeof assistant["enabled"] === "boolean" ? assistant["enabled"] : agent.is_personal;
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [model, setModel] = useState(agent.model);
  const [tools, setTools] = useState<string[]>(agent.tools);
  const [toolsMode, setToolsMode] = useState<"selected" | "all">(agent.tools_mode ?? "selected");
  const [generativeUi, setGenerativeUi] = useState<boolean>(agent.generative_ui ?? true);
  const [integrations, setIntegrations] = useState<AgentIntegration[]>(agent.integrations);
  const attachable = useAttachableIntegrations();
  const models = useModelOptions();
  const [catalog, setCatalog] = useState<AgentToolInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void listAgentTools()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  const groups = useMemo(() => groupTools(catalog), [catalog]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateAgent(agent.id, {
        name: name.trim(),
        description: description.trim(),
        model,
        tools,
        tools_mode: toolsMode,
        generative_ui: generativeUi,
        resources: { ...agentResources, assistant },
        ...(toolsMode === "selected" ? { integrations } : {}),
      });
      setSaved(true);
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
          <p className="text-sm text-muted-foreground">Only the owner or an admin can change this agent.</p>
        </Section>
        <ReadOnlyConfig agent={agent} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Section title="Assistant">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(assistantEnabled)}
            onChange={(e) => setAssistant({ ...assistant, enabled: e.target.checked })}
          />
          Persistent coordination
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          Keeps track of conversations and ongoing work, delegates tasks and follows up. Scheduled checks and
          responsibilities use this agent's workspace.
        </p>
        {assistantEnabled && (
          <>
            <Button
              className="mt-3"
              variant="outline"
              disabled={onOpenChat === undefined}
              onClick={() => {
                void openAssistant(agent.id)
                  .then(({ chat_id }) => onOpenChat?.(chat_id))
                  .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
              }}
            >
              Open assistant
            </Button>
            {!agent.is_personal && (
              <label className="mt-3 block space-y-1 text-xs">
                Access scope
                <Select
                  value={assistant["scope"] === "member" ? "member" : "agent"}
                  onValueChange={(v) => setAssistant({ ...assistant, scope: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Agent grants</SelectItem>
                    <SelectItem value="member">Member scope</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {["coordinator", "worker", "reflection", "compaction"].map((role) => (
                <label key={role} className="space-y-1 text-xs">
                  <span className="capitalize">{role} model</span>
                  <Select
                    value={
                      typeof assistant[`${role}_model`] === "string" && assistant[`${role}_model`] !== ""
                        ? String(assistant[`${role}_model`])
                        : "inherit"
                    }
                    onValueChange={(v) => setAssistant({ ...assistant, [`${role}_model`]: v === "inherit" ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">Use agent model</SelectItem>
                      {(models ?? []).map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {modelLabel(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Shared agents use their granted integrations and do not support account impersonation. New integration
              grants start read-only.
            </p>
          </>
        )}
      </Section>
      <Section title="Agent configuration">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium">Description</span>
            <Textarea
              value={description}
              maxLength={500}
              rows={3}
              placeholder="What this agent does and when to spawn it."
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">Other agents read this to decide whom to spawn.</span>
          </label>
        </div>
        <div className="mt-4 space-y-2">
          <span className="text-xs font-medium">Access</span>
          <AccessPanel kind="agent" id={agent.id} />
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-foreground"
            checked={generativeUi}
            onChange={(e) => setGenerativeUi(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Generated UI</span>
            <span className="block text-xs text-muted-foreground">
              Replies can include interactive cards, tables, charts, forms and buttons.
            </span>
          </span>
        </label>
      </Section>

      <Section
        title="Tools"
        description={toolsMode === "all" ? "All available tools" : `${tools.length} selected`}
        action={
          toolsMode === "selected" && catalog.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setTools(catalog.map((t) => t.name))}>
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
                Every built-in tool and every integration an admin makes available to the people who use this agent, at
                the access the admin grants. Nothing else to set.
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
              <span className="block text-xs text-muted-foreground">Only the tools selected below.</span>
            </span>
          </label>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {toolsMode === "all"
            ? "Codemode is always available."
            : "Codemode is always available. Integrations are chosen in their own section."}
        </p>
        {toolsMode === "all" ? (
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">
              This agent uses every built-in tool and these integrations, as an admin set them up:
            </p>
            <DerivedIntegrations entries={agent.integrations} />
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The org tool catalog did not load. The current allowlist is shown below.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.group} className="space-y-1.5">
                <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{group.group}</p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
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
                          <span className="block text-sm font-medium">{tool.label || tool.name}</span>
                          <span className="block text-xs text-muted-foreground">{tool.description}</span>
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
              <span key={tool} className="rounded-md border border-border px-2 py-0.5 font-mono text-2xs">
                {tool}
              </span>
            ))}
          </div>
        )}
      </Section>

      {toolsMode === "selected" && (
        <Section title="Integrations" description={integrations.length === 0 ? "None" : `${integrations.length} added`}>
          <p className="mb-3 text-xs text-muted-foreground">
            Everyone who can use this agent reaches what is listed here, whatever their own access.
          </p>
          <AgentIntegrationsEditor
            value={integrations}
            onChange={setIntegrations}
            attachable={attachable}
            warnings={agent.integration_warnings}
            isAdmin={viewer.role === "admin"}
          />
        </Section>
      )}

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
        <div className="flex flex-wrap items-center gap-2">
          <AgentActions agent={agent} manage={manage} onDeleted={onDeleted} />
          <span className="text-xs text-muted-foreground">Archive, restore, export or delete this agent.</span>
        </div>
        {agent.status === "deleting" && agent.purge_after && (
          <p className="mt-2 text-xs text-muted-foreground">
            Purge is scheduled after {new Date(agent.purge_after).toLocaleString()}.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Signed in as {viewer.email}. Owner and admin actions are audited.
        </p>
      </Section>
    </div>
  );
}

/** An `all`-tools agent's integrations: what the admin's integration
 *  access gives everyone who uses it. Read-only. */
function DerivedIntegrations({ entries }: { entries: AgentIntegration[] }) {
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No integrations yet.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((entry) => (
        <span key={entry.slug} className="rounded-md border border-border px-2 py-0.5 text-xs">
          <span className="font-mono">{entry.slug}</span>{" "}
          <span className="text-muted-foreground">{CLASS_LABEL[entry.ceiling].toLowerCase()}</span>
        </span>
      ))}
    </div>
  );
}

export function ReadOnlyConfig({ agent }: { agent: Agent }) {
  return (
    <Section title="Configuration">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{agent.name}</dd>
        </div>
        {agent.description ? (
          <div>
            <dt className="text-muted-foreground">Description</dt>
            <dd className="mt-0.5">{agent.description}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Model</dt>
          <dd className="text-xs">
            <ModelName id={agent.model} alias={agent.model_alias} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Access</dt>
          <dd>
            {agent.visibility === "org"
              ? "Everyone in the org"
              : agent.team_ids.length > 0
                ? "Shared with teams"
                : "Only you"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Generated UI</dt>
          <dd>{agent.generative_ui ? "On" : "Off"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tools</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {agent.tools_mode === "all" ? (
              <span className="text-xs">Every built-in tool and integration an admin makes available</span>
            ) : (
              agent.tools.map((tool) => <Mono key={tool}>{tool}</Mono>)
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Integrations</dt>
          <dd className="mt-1 space-y-1">
            {agent.integrations.length === 0 ? (
              <span className="text-xs">None</span>
            ) : (
              agent.integrations.map((entry) => (
                <div key={entry.slug}>
                  <span className="text-xs">
                    <Mono>{entry.slug}</Mono> {CLASS_LABEL[entry.ceiling].toLowerCase()}
                  </span>
                  <IntegrationWarnings
                    warnings={agent.integration_warnings.filter((w) => w.integration === entry.slug)}
                    title={entry.slug}
                  />
                </div>
              ))
            )}
          </dd>
        </div>
      </dl>
    </Section>
  );
}

export function AgentActions({ agent, manage, onDeleted }: { agent: Agent; manage: boolean; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const archived = agent.status === "archived" || agent.status === "deleting";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
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
      await downloadAgentExport(agent);
    } finally {
      setExporting(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="pointer-coarse:size-10"
          aria-label="Agent actions"
          disabled={busy}
        >
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
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirmOpen(true)}>
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
              The agent stops now and disappears from the directory. Its workspace, threads and runs stay recoverable
              during the organization&apos;s grace period (30 days by default); after that they are purged. Download an
              export first if you need the definitions and run history.
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

async function downloadAgentExport(agent: Agent): Promise<void> {
  const bundle = await exportAgent(agent.id);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${agent.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}-export.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
