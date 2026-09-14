//! IntegrationsSection — available and configured integrations in one data
//! table with first-class add (header button + catalog rows) and delete
//! (per-row and detail actions). The detail page (addressed by the row's
//! id, /settings/integrations/<id>) renders its settings form dynamically
//! from the integration's manifest field schema — no hardcoded per-connector
//! UI — plus a secrets editor (masked previews, write-only values) and,
//! for MCP plugins, the mcp url and a per-role tool-policy editor.

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { DataTable } from "@guild/ui/components/data-table";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";
import { PageHeader } from "../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "../components/empty-state";
import { FactCard, FactGrid } from "../components/fact-card";

/** One manifest-declared settings field — the detail form is generated
 * from these; the manifest is the schema. */
interface FieldSpec {
  name: string;
  kind: string; // string | text | number | boolean
  label?: string | null;
  required?: boolean;
  default?: unknown;
  help?: string | null;
  placeholder?: string | null;
}

interface IntegrationRow {
  id: string;
  org_id: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  category?: string;
  secret_names?: string[];
  settings?: { fields?: FieldSpec[] } | null;
}

interface AvailableEntry {
  name: string;
  category?: string;
  secret_names?: string[];
  settings?: { fields?: FieldSpec[] } | null;
}

interface SecretEntry {
  name: string;
  updated_at: string;
  masked?: string;
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

const categoryLabel = (c?: string) =>
  CATEGORY_LABELS[c ?? "other"] ?? CATEGORY_LABELS.other;

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

const toggleClass = (
  policy: ToolPolicy,
  role: ToolRole,
  cls: ToolClass,
): ToolPolicy => {
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
    {
      key: string;
      name: string;
      category?: string;
      secretNames: string[];
      fields: FieldSpec[];
      row?: IntegrationRow;
    }[]
  >(() => {
    if (rows === null || available === null) return [];
    const configuredNames = new Set(rows.map((r) => r.name));
    return [
      ...rows.map((r) => ({
        key: r.id,
        name: r.name,
        category: r.category,
        secretNames: r.secret_names ?? [],
        fields: r.settings?.fields ?? [],
        row: r,
      })),
      ...available
        .filter((a) => !configuredNames.has(a.name))
        .map((a) => ({
          key: `available-${a.name}`,
          name: a.name,
          category: a.category,
          secretNames: a.secret_names ?? [],
          fields: a.settings?.fields ?? [],
        })),
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
      const created = await api<{ id: string }>(
        "POST",
        "/api/v1/admin/integrations",
        {
          name: entry.name,
        },
      );
      toast.success("Integration added", { description: entry.name });
      reload();
      onDetailChange(created.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Could not add integration", { description: msg });
    }
  };

  const removeRow = async (row: IntegrationRow) => {
    try {
      await api("DELETE", `/api/v1/admin/integrations/${row.id}`);
      toast.success("Integration removed", { description: row.name });
      setPendingRemove(null);
      reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Could not remove integration", { description: msg });
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
        cell: ({ row }) => (
          <Badge variant="secondary">
            {categoryLabel(row.original.category)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.row ? (
            <StatusBadge enabled={row.original.row.enabled} />
          ) : (
            <span className="text-xs text-muted-foreground">
              not configured
            </span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end">
            {row.original.row ? (
              <button
                className="text-muted-foreground transition-colors hover:text-destructive"
                title={`Remove ${row.original.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingRemove(row.original.row!);
                }}
              >
                <Trash2 className="size-4" />
              </button>
            ) : (
              <button
                className="text-muted-foreground transition-colors hover:text-foreground"
                title={`Add ${row.original.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void openIntegration(row.original);
                }}
              >
                <Plus className="size-4" />
              </button>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  const [pendingRemove, setPendingRemove] = useState<IntegrationRow | null>(
    null,
  );
  const [addOpen, setAddOpen] = useState(false);

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
            back={{
              label: "Integrations",
              onClick: () => onDetailChange(null),
            }}
          />
          <p className="text-sm text-muted-foreground">
            This integration no longer exists.
          </p>
        </div>
      );
    }
    return (
      <IntegrationDetail
        key={configured.id}
        id={configured.id}
        name={configured.name}
        category={configured.category ?? "other"}
        secretNames={configured.secret_names ?? []}
        fields={configured.settings?.fields ?? []}
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
        description="Connectors and MCP plugins that contribute tools to chats."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" /> Add integration
          </Button>
        }
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

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add integration</DialogTitle>
            <DialogDescription>
              Pick a connector or plugin to add to this workspace. It starts
              disabled until its settings and secrets are in.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto">
            {available === null ? (
              <Skeleton className="h-10 w-full" />
            ) : available.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">
                Everything available is already added.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {available.map((a) => (
                  <li key={a.name}>
                    <button
                      className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-accent"
                      onClick={() => {
                        setAddOpen(false);
                        void openIntegration({
                          key: `available-${a.name}`,
                          name: a.name,
                          category: a.category,
                          secretNames: a.secret_names ?? [],
                          fields: a.settings?.fields ?? [],
                        });
                      }}
                    >
                      <Webhook className="size-4 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{a.name}</span>
                      <Badge variant="secondary" className="ml-auto">
                        {categoryLabel(a.category)}
                      </Badge>
                      {(a.secret_names?.length ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {a.secret_names!.length} secret
                          {a.secret_names!.length === 1 ? "" : "s"}
                        </span>
                      )}
                      <Plus className="size-4 text-muted-foreground/60" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => !open && setPendingRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRemove?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The configuration and stored secrets are deleted; tools disappear
              from chats. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingRemove && void removeRow(pendingRemove)}
            >
              Remove configuration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IntegrationDetail({
  id,
  name,
  category,
  secretNames,
  fields,
  initialConfig,
  initialEnabled,
  onChanged,
  onBack,
}: {
  id: string;
  name: string;
  category?: string;
  secretNames: string[];
  fields: FieldSpec[];
  initialConfig: Record<string, unknown>;
  initialEnabled: boolean;
  onChanged: () => void;
  onBack: () => void;
}) {
  const isMcp =
    typeof initialConfig?.mcp === "object" && initialConfig.mcp !== null;
  // Schema-driven connectors edit through a form generated from the
  // manifest fields; everything else (MCP plugins, schema-less rows) edits
  // as raw JSON.
  const useForm = !isMcp && fields.length > 0;
  // The saved integration is facts first; editing is an explicit mode.
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [text, setText] = useState(JSON.stringify(initialConfig, null, 2));
  // Form draft: one entry per manifest field.
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Stored secrets: masked previews + timestamps, values never.
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [confirmSecret, setConfirmSecret] = useState<string | null>(null);
  // Tool policy draft: checkbox state per role; saved into config.tool_policy.
  const [policy, setPolicy] = useState<ToolPolicy>(readPolicy(initialConfig));

  const secretsPath = `/api/v1/admin/integrations/${id}/secrets`;
  const secretsRes = useCachedGet<{ secrets: SecretEntry[] }>(secretsPath);
  const secrets = secretsRes.data?.secrets ?? null;
  const reloadSecrets = secretsRes.reload;

  const enterEdit = () => {
    setText(JSON.stringify(initialConfig, null, 2));
    setDraft(
      Object.fromEntries(
        fields.map((f) => [
          f.name,
          initialConfig[f.name] ??
            f.default ??
            (f.kind === "boolean" ? false : ""),
        ]),
      ),
    );
    setEnabled(initialEnabled);
    setPolicy(readPolicy(initialConfig));
    setError(null);
    setMode("edit");
  };

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
      let cfg: Record<string, unknown>;
      if (useForm) {
        // Start from the stored config so keys the schema does not know
        // (legacy fields, tool_policy) survive; schema fields are set from
        // the form.
        cfg = { ...initialConfig };
        for (const f of fields) {
          const value = draft[f.name];
          if (f.kind === "boolean") {
            cfg[f.name] = value === true;
          } else if (f.kind === "number") {
            const n = Number(value);
            if (value === "" || value === null || Number.isNaN(n)) {
              if (f.required) throw new Error(`${fieldLabel(f)} is required`);
              delete cfg[f.name];
            } else {
              cfg[f.name] = n;
            }
          } else {
            const s = String(value ?? "");
            if (s === "") {
              if (f.required) throw new Error(`${fieldLabel(f)} is required`);
              delete cfg[f.name];
            } else {
              cfg[f.name] = s;
            }
          }
        }
      } else {
        cfg = JSON.parse(text) as Record<string, unknown>;
      }
      const clean = cleanPolicy(policy);
      if (Object.keys(clean).length > 0) cfg.tool_policy = clean;
      else if (isMcp) delete cfg.tool_policy;
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
            : "Disabled; the configuration is kept, no tools are contributed."
        }
        back={{ label: "Integrations", onClick: onBack }}
        actions={
          <>
            <Button onClick={enterEdit}>Edit</Button>
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
              {String(
                (initialConfig.mcp as Record<string, unknown>).url ??
                  "(no url)",
              )}
            </p>
          </FactCard>
        )}
      </FactGrid>

      {/* Settings: manifest-declared fields with their current values. */}
      {fields.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Settings
          </p>
          <dl className="mt-3 space-y-3">
            {fields.map((f) => {
              const value = initialConfig[f.name];
              const shown =
                value !== undefined
                  ? String(value)
                  : f.default !== undefined && f.default !== null
                    ? `${String(f.default)} (default)`
                    : "not set";
              return (
                <div key={f.name} className="flex items-baseline gap-4">
                  <dt className="w-48 shrink-0 text-sm">
                    {fieldLabel(f)}
                    {f.required && (
                      <span className="ml-1 text-destructive">*</span>
                    )}
                  </dt>
                  <dd className="min-w-0">
                    <p
                      className={`truncate font-mono text-xs ${
                        value === undefined ? "text-muted-foreground" : ""
                      }`}
                    >
                      {shown}
                    </p>
                    {f.help && (
                      <p className="text-xs text-muted-foreground">{f.help}</p>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}

      {isMcp && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Config
          </p>
          {Object.keys(initialConfig).length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Empty config.</p>
          ) : (
            <pre className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed">
              {JSON.stringify(initialConfig, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-1.5">
          <KeyRound className="size-3.5 text-muted-foreground" />
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Secrets
          </p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {isMcp
            ? "Passed to the MCP server as headers on connect."
            : "Credentials the connector's tools use on every call."}{" "}
          Values are never shown — only a masked preview. An enabled integration
          must have every required secret stored.
        </p>
        {secrets === null ? (
          <Skeleton className="mt-3 h-8 w-56" />
        ) : secrets.length === 0 && secretNames.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            This integration needs no secrets.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border/60">
            {secretNames.map((required) => {
              const stored = secrets?.find((s) => s.name === required);
              return (
                <li
                  key={required}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{required}</span>
                  {stored ? (
                    <>
                      <span className="font-mono text-xs text-muted-foreground">
                        {stored.masked || "••••"}
                      </span>
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        updated {new Date(stored.updated_at).toLocaleString()}
                      </span>
                    </>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 text-amber-600 dark:text-amber-400"
                    >
                      missing
                    </Badge>
                  )}
                  {stored && (
                    <button
                      className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                      title="Delete secret"
                      onClick={() => setConfirmSecret(required)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
            {secrets
              ?.filter((s) => !secretNames.includes(s.name))
              .map((s) => (
                <li
                  key={s.name}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    additional
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.masked || "••••"}
                  </span>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
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
              placeholder={secretNames[0] ?? "e.g. api_key"}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Value (write-only)
            </p>
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

          {useForm ? (
            fields.map((f) => (
              <Field
                key={f.name}
                label={`${fieldLabel(f)}${f.required ? " *" : ""}`}
                hint={f.help ?? undefined}
              >
                {f.kind === "boolean" ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-foreground"
                      checked={draft[f.name] === true}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [f.name]: e.target.checked,
                        }))
                      }
                    />
                    <span className="text-muted-foreground">Enabled</span>
                  </label>
                ) : f.kind === "text" ? (
                  <Textarea
                    className="min-h-24"
                    spellCheck={false}
                    placeholder={f.placeholder ?? undefined}
                    value={String(draft[f.name] ?? "")}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [f.name]: e.target.value }))
                    }
                  />
                ) : (
                  <Input
                    type={f.kind === "number" ? "number" : "text"}
                    className="max-w-md"
                    spellCheck={false}
                    placeholder={
                      f.placeholder ??
                      (f.default !== undefined && f.default !== null
                        ? String(f.default)
                        : undefined)
                    }
                    value={String(draft[f.name] ?? "")}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [f.name]: e.target.value }))
                    }
                  />
                )}
              </Field>
            ))
          ) : (
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
          )}

          {isMcp && (
            <Field
              label="Tool policy"
              hint="Classes each role may call; unchecked roles get the manifest defaults."
            >
              <div className="grid grid-cols-2 gap-3">
                {ROLES.map((role) => (
                  <div
                    key={role}
                    className="rounded-lg border border-border px-3 py-2.5"
                  >
                    <p className="text-sm font-medium capitalize">{role}</p>
                    <div className="mt-1.5 space-y-1.5">
                      {TOOL_CLASSES.map((cls) => (
                        <label
                          key={cls}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-foreground"
                            checked={policy[role]?.includes(cls) ?? false}
                            onChange={() =>
                              setPolicy((p) => toggleClass(p, role, cls))
                            }
                          />
                          <span className="capitalize text-muted-foreground">
                            {cls}
                          </span>
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
            <Button variant="ghost" onClick={() => setMode("view")}>
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
              The configuration and stored secrets are deleted; tools disappear
              from chats. This cannot be undone.
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
              “{confirmSecret}” is removed; calls that need it start failing.
              This cannot be undone.
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

function fieldLabel(f: FieldSpec): string {
  return f.label ?? f.name.replace(/_/g, " ");
}
