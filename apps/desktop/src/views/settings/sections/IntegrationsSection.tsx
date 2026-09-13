//! IntegrationsSection — available and configured integrations in one data
//! table (status column distinguishes configured / not configured); the
//! detail page (addressed by the row's id, /settings/integrations/<id>)
//! holds the enable toggle, JSON config editor, save and remove. MCP plugin
//! rows additionally show the mcp url, secret names with timestamps, a
//! write-only secret form, and a per-role tool-policy editor.

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { KeyRound, Plug, Plus, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { api } from "../admin-api";
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
import { DataTable } from "@guild/ui/components/data-table";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";
import { PageHeader } from "../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "../components/empty-state";
import { FactCard, FactGrid } from "../components/fact-card";

interface IntegrationRow {
  id: string;
  org_id: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  category?: string;
}

interface AvailableEntry {
  name: string;
  category?: string;
}

interface SecretEntry {
  name: string;
  updated_at: string;
}

const TOOL_CLASSES = ["read", "write", "admin"] as const;
type ToolClass = (typeof TOOL_CLASSES)[number];
type ToolRole = "member" | "admin";
type ToolPolicy = Partial<Record<ToolRole, ToolClass[]>>;

const CATEGORY_LABELS: Record<string, string> = {
  fetch: "Fetch provider",
  search: "Search provider",
  other: "Other",
  mcp: "MCP plugin",
};

const categoryLabel = (c?: string) => CATEGORY_LABELS[c ?? "other"] ?? CATEGORY_LABELS.other;

const ROLES: ToolRole[] = ["member", "admin"];

/** Reads config.tool_policy into the checkbox-editor shape, ignoring
 * anything the editor cannot represent. */
function readPolicy(config: Record<string, unknown> | null): ToolPolicy {
  const raw = config?.["tool_policy"] as Record<string, unknown> | undefined;
  const out: ToolPolicy = {};
  for (const role of ROLES) {
    const list = raw?.[role];
    if (Array.isArray(list)) {
      const classes = list.filter((c): c is ToolClass =>
        (TOOL_CLASSES as readonly string[]).includes(c as string),
      );
      if (classes.length > 0) out[role] = classes;
    }
  }
  return out;
}

/** Drops empty role lists so the saved config stays minimal. */
function cleanPolicy(policy: ToolPolicy): ToolPolicy {
  const out: ToolPolicy = {};
  for (const role of ROLES) {
    if (policy[role]?.length) out[role] = policy[role];
  }
  return out;
}

const toggleClass = (policy: ToolPolicy, role: ToolRole, cls: ToolClass): ToolPolicy => {
  const cur = policy[role] ?? [];
  const next = cur.includes(cls) ? cur.filter((c) => c !== cls) : [...cur, cls];
  return { ...policy, [role]: next };
};

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge
      variant="outline"
      className="border-transparent bg-accent text-muted-foreground"
    >
      <span
        className={`mr-1.5 inline-block size-1.5 rounded-full ${
          enabled ? "bg-emerald-500" : "bg-muted-foreground/40"
        }`}
      />
      {enabled ? "enabled" : "disabled"}
    </Badge>
  );
}

export default function IntegrationsSection({
  detail = null,
  onDetailChange,
}: SectionDetailProps) {
  const list = useCachedGet<{
    integrations: IntegrationRow[];
    available: AvailableEntry[];
  }>("/api/v1/admin/integrations");
  const rows = list.data?.integrations ?? null;
  const available = list.data?.available ?? null;
  const error = list.error;
  const reload = list.reload;

  // A unified table row: configured integrations plus not-yet-configured
  // catalog entries (status "not configured"; clicking one creates the row).
  const tableRows = useMemo<
    { key: string; name: string; category?: string; row?: IntegrationRow }[]
  >(() => {
    if (rows === null || available === null) return [];
    const configuredNames = new Set(rows.map((r) => r.name));
    return [
      ...rows.map((r) => ({ key: r.id, name: r.name, category: r.category, row: r })),
      ...available
        .filter((a) => !configuredNames.has(a.name))
        .map((a) => ({ key: `available-${a.name}`, name: a.name, category: a.category })),
    ];
  }, [rows, available]);

  /// Opens a detail page by id. A not-yet-configured connector has no row
  /// (and no id) yet: creating its configuration is the first click's job —
  /// the row starts disabled and the navigation lands on its id.
  const openIntegration = async (entry: (typeof tableRows)[number]) => {
    if (entry.row) {
      onDetailChange(entry.row.id);
      return;
    }
    try {
      const created = await api<{ id: string }>("POST", "/api/v1/admin/integrations", {
        name: entry.name,
      });
      toast.success("Integration created", { description: entry.name });
      reload();
      onDetailChange(created.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Could not create integration", { description: msg });
    }
  };

  const columns = useMemo<ColumnDef<(typeof tableRows)[number], any>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Integration",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <Webhook className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{row.original.name}</span>
          </div>
        ),
      },
      {
        accessorKey: "category",
        header: "Type",
        cell: ({ row }) => <Badge variant="secondary">{categoryLabel(row.original.category)}</Badge>,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.row ? (
            <StatusBadge enabled={row.original.row.enabled} />
          ) : (
            <span className="text-xs text-muted-foreground">not configured</span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          row.original.row ? null : (
            <div className="flex justify-end">
              <Plus className="size-4 text-muted-foreground/60" />
            </div>
          ),
      },
    ],
    [],
  );

  if (detail !== null) {
    // Deep-linked detail: wait for the list before resolving the id —
    // otherwise a not-yet-loaded row would render as not-found.
    if (rows === null || available === null) {
      return (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      );
    }
    const configured = rows.find((r) => r.id === detail);
    if (!configured) {
      return (
        <div>
          <PageHeader
            title="Integrations"
            back={{ label: "Integrations", onClick: () => onDetailChange(null) }}
          />
          <p className="text-sm text-muted-foreground">This integration no longer exists.</p>
        </div>
      );
    }
    return (
      <IntegrationDetail
        id={configured.id}
        name={configured.name}
        category={configured.category ?? "other"}
        initialConfig={configured.config}
        initialEnabled={configured.enabled}
        onChanged={reload}
        onBack={() => {
          reload();
          onDetailChange(null);
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connectors and MCP plugins that contribute tools to chats. Click a not-configured connector to set it up."
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <DataTable
        columns={columns}
        data={rows !== null && available !== null ? tableRows : null}
        search={(r) => `${r.name} ${categoryLabel(r.category)}`}
        searchPlaceholder="Search integrations…"
        onRowClick={openIntegration}
        empty={
          <EmptyState
            icon={Plug}
            title="No integrations available"
            hint="This build ships no connectors or registry plugins."
          />
        }
      />
    </div>
  );
}

function IntegrationDetail({
  id,
  name,
  category,
  initialConfig,
  initialEnabled,
  onChanged,
  onBack,
}: {
  id: string;
  name: string;
  category?: string;
  initialConfig: Record<string, unknown>;
  initialEnabled: boolean;
  onChanged: () => void;
  onBack: () => void;
}) {
  const isMcp =
    typeof initialConfig?.mcp === "object" && initialConfig.mcp !== null;
  // The saved integration is facts first; editing is an explicit mode.
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [text, setText] = useState(JSON.stringify(initialConfig, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // MCP plugin facts: stored secret names + timestamps, never values.
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [confirmSecret, setConfirmSecret] = useState<string | null>(null);
  // Tool policy draft: checkbox state per role; saved into config.tool_policy.
  const [policy, setPolicy] = useState<ToolPolicy>(
    readPolicy(initialConfig),
  );

  const secretsPath = `/api/v1/admin/integrations/${id}/secrets`;
  const secretsRes = useCachedGet<{ secrets: SecretEntry[] }>(secretsPath);
  const secrets = secretsRes.data?.secrets ?? null;
  const reloadSecrets = secretsRes.reload;

  const fail = (e: unknown, title: string) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    toast.error(title, { description: msg });
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const cfg = JSON.parse(text) as Record<string, unknown>;
      const clean = cleanPolicy(policy);
      if (Object.keys(clean).length > 0) cfg.tool_policy = clean;
      else delete cfg.tool_policy;
      await api("PUT", `/api/v1/admin/integrations/${id}`, {
        config: cfg,
        enabled,
      });
      toast.success("Integration saved", { description: name });
      onChanged();
      setMode("view");
    } catch (e) {
      fail(
        e instanceof SyntaxError
          ? new Error(`config is not valid JSON: ${e.message}`)
          : e,
        "Save failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    if (busy || !secretName.trim() || !secretValue) return;
    setBusy(true);
    setError(null);
    try {
      await api("PUT", `/api/v1/admin/integrations/${id}/secrets`, {
        name: secretName.trim(),
        value: secretValue,
      });
      toast.success("Secret saved", { description: secretName.trim() });
      setSecretName("");
      setSecretValue("");
      reloadSecrets();
    } catch (e) {
      fail(e, "Could not save secret");
    } finally {
      setBusy(false);
    }
  };

  const deleteSecret = async (secret: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        "DELETE",
        `/api/v1/admin/integrations/${id}/secrets/${encodeURIComponent(secret)}`,
      );
      toast.success("Secret deleted", { description: secret });
      setConfirmSecret(null);
      onChanged();
      reloadSecrets();
    } catch (e) {
      fail(e, "Could not delete secret");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api("DELETE", `/api/v1/admin/integrations/${id}`);
      toast.success("Integration removed", { description: name });
      onBack();
    } catch (e) {
      fail(e, "Could not remove integration");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={name}
        description={
          initialEnabled
            ? "Enabled — tools join the chat loop."
            : "Configured but disabled; the config is kept, no tools are contributed."
        }
        back={{ label: "Integrations", onClick: onBack }}
        actions={
          <>
            <Button onClick={() => setMode("edit")}>Edit</Button>
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5" /> Remove
            </Button>
          </>
        }
      />

      {/* view: saved facts + explicit actions */}
      <FactGrid>
        <FactCard label="Type">
          <Badge variant="secondary">{categoryLabel(category)}</Badge>
        </FactCard>
        <FactCard label="Status">
          <StatusBadge enabled={initialEnabled} />
        </FactCard>
        {isMcp && (
          <FactCard label="Connection" className="sm:col-span-2">
            <p className="break-all font-mono text-xs">
              {String((initialConfig.mcp as Record<string, unknown>).url ?? "(no url)")}
            </p>
          </FactCard>
        )}
      </FactGrid>

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Config</p>
        <pre className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed">
          {JSON.stringify(initialConfig, null, 2)}
        </pre>
      </div>

      {isMcp && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-1.5">
            <KeyRound className="size-3.5 text-muted-foreground" />
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Secrets
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Passed to the MCP server as headers on connect; values are never shown or returned by
            the API.
          </p>
          {secrets === null ? (
            <Skeleton className="mt-3 h-8 w-56" />
          ) : secrets.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No secrets stored.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border/60">
              {secrets.map((s) => (
                <li key={s.name} className="flex items-center gap-3 py-2 text-sm">
                  <span className="font-mono text-xs">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    updated {new Date(s.updated_at).toLocaleString()}
                  </span>
                  <button
                    className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                    title="Delete secret"
                    onClick={() => setConfirmSecret(s.name)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border/60 pt-3">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Name</p>
              <Input
                className="h-8 w-40 font-mono text-xs"
                value={secretName}
                onChange={(e) => setSecretName(e.target.value)}
                placeholder="e.g. api_key"
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Value (write-only)</p>
              <Input
                className="h-8 w-56 font-mono text-xs"
                type="password"
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                placeholder="add or replace"
              />
            </div>
            <Button
              size="sm"
              className="h-8"
              disabled={busy || !secretName.trim() || !secretValue}
              onClick={saveSecret}
            >
              {busy ? "Saving…" : "Save secret"}
            </Button>
          </div>
        </div>
      )}

      {isMcp && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Tool policy
          </p>
          {Object.keys(cleanPolicy(readPolicy(initialConfig))).length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Default — manifest tool classes apply to every role.
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-3">
              {ROLES.map((role) => {
                const classes = readPolicy(initialConfig)[role];
                if (!classes?.length) return null;
                return (
                  <div key={role}>
                    <p className="text-sm font-medium capitalize">{role}</p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {classes.join(", ")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {mode === "edit" && (
        <div className="space-y-5 rounded-lg border border-border bg-card p-5">
          <PageHeader title="Edit integration" />
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-foreground"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>
              Enabled
              <span className="block text-xs text-muted-foreground">
                Disabled integrations keep their config but contribute no tools.
              </span>
            </span>
          </label>

          <Field
            label="Config (JSON)"
            hint="Merged with the tool policy below on save."
          >
            <Textarea
              className="min-h-40 font-mono text-xs"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>

          {isMcp && (
            <Field
              label="Tool policy"
              hint="Classes each role may call; unchecked roles get the manifest defaults."
            >
              <div className="grid grid-cols-2 gap-3">
                {ROLES.map((role) => (
                  <div key={role} className="rounded-lg border border-border px-3 py-2.5">
                    <p className="text-sm font-medium capitalize">{role}</p>
                    <div className="mt-1.5 space-y-1.5">
                      {TOOL_CLASSES.map((cls) => (
                        <label key={cls} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-foreground"
                            checked={policy[role]?.includes(cls) ?? false}
                            onChange={() => setPolicy((p) => toggleClass(p, role, cls))}
                          />
                          <span className="capitalize text-muted-foreground">{cls}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Field>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setText(JSON.stringify(initialConfig, null, 2));
                setEnabled(initialEnabled);
                setPolicy(readPolicy(initialConfig));
                setError(null);
                setMode("view");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The configuration and stored secrets are deleted; tools disappear from chats.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Removing…" : "Remove configuration"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmSecret !== null}
        onOpenChange={(open) => !open && setConfirmSecret(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete secret?</AlertDialogTitle>
            <AlertDialogDescription>
              “{confirmSecret}” is removed; calls that need it start failing. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={() => confirmSecret && deleteSecret(confirmSecret)}
            >
              {busy ? "Deleting…" : "Delete secret"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
