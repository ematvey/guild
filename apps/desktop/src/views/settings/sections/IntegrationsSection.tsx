//! IntegrationsSection — available and configured integrations in one data
//! table with first-class add (header button + catalog rows). Removal is a
//! detail-page action only — the list stays read-only. The detail page (addressed by the row's
//! id, /settings/integrations/<id>) renders its settings form dynamically
//! from the integration's manifest field schema — no hardcoded per-connector
//! UI — plus a secrets editor (masked previews, write-only values) and,
//! for MCP plugins, the mcp url and a per-role tool-policy editor.

import { useMemo, useState, useEffect } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { Plug, Plus, Trash2, Webhook } from "lucide-react";
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
    </div>
  );
}

// Per-credential widgets: every secret name renders as a purposeful,
// labeled input — password/textarea/email by the credential's shape —
// never a generic name+value pair.
const SECRET_WIDGETS: Record<
  string,
  {
    label: string;
    kind: "password" | "text" | "email" | "textarea";
    placeholder?: string;
  }
> = {
  token: { label: "API token", kind: "password" },
  api_key: { label: "API key", kind: "password" },
  bot_token: { label: "Bot token", kind: "password", placeholder: "xoxb-…" },
  secret_key: { label: "Secret key", kind: "password" },
  public_key: { label: "Public key", kind: "text" },
  email: { label: "Email", kind: "email" },
  admin_email: { label: "Admin email", kind: "email" },
  site: {
    label: "Site URL",
    kind: "text",
    placeholder: "https://yourorg.atlassian.net",
  },
  host: {
    label: "Host URL",
    kind: "text",
    placeholder: "https://langfuse.example.com",
  },
  service_account_json: {
    label: "Service account JSON",
    kind: "textarea",
    placeholder: "{ … }",
  },
};

const secretWidget = (name: string) =>
  SECRET_WIDGETS[name] ?? {
    label: name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    kind: "password" as const,
  };

/** The initial editable state, derived from the stored row. The page is
 * the form — one surface, no separate edit mode; dirty state drives
 * Save. */
function initialState(
  fields: FieldSpec[],
  initialConfig: Record<string, unknown>,
  initialEnabled: boolean,
  isMcp: boolean,
) {
  const advanced: Record<string, unknown> = {};
  if (isMcp) {
    for (const [k, v] of Object.entries(initialConfig)) {
      if (k !== "mcp" && k !== "tool_policy") advanced[k] = v;
    }
  }
  return {
    enabled: initialEnabled,
    draft: Object.fromEntries(
      fields.map((f) => [
        f.name,
        initialConfig[f.name] ??
          f.default ??
          (f.kind === "boolean" ? false : ""),
      ]),
    ),
    mcpUrl: isMcp
      ? String((initialConfig.mcp as Record<string, unknown>).url ?? "")
      : "",
    advancedText: isMcp ? JSON.stringify(advanced, null, 2) : "",
    policy: readPolicy(initialConfig),
  };
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
  const initial = useMemo(
    () => initialState(fields, initialConfig, initialEnabled, isMcp),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialConfig, fields, initialEnabled],
  );
  const [state, setState] = useState(initial);
  // A save triggers a list reload; the new row identity resets the form.
  useEffect(() => setState(initial), [initial]);

  const { enabled, draft, mcpUrl, advancedText, policy } = state;
  const patch = (p: Partial<typeof state>) => setState((s) => ({ ...s, ...p }));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // New credential values keyed by field name; empty/absent = unchanged.
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});

  const secretsPath = `/api/v1/admin/integrations/${id}/secrets`;
  const secretsRes = useCachedGet<{ secrets: SecretEntry[] }>(secretsPath);
  const secrets = secretsRes.data?.secrets ?? null;

  const dirty =
    enabled !== initial.enabled ||
    JSON.stringify(draft) !== JSON.stringify(initial.draft) ||
    (isMcp && mcpUrl !== initial.mcpUrl) ||
    (isMcp && advancedText !== initial.advancedText) ||
    (isMcp && JSON.stringify(policy) !== JSON.stringify(initial.policy)) ||
    Object.values(secretDraft).some((v) => v !== "");

  // Credential fields render inline in the same form, masked and
  // grayed-out until explicitly unlocked. Legacy manifests declare them
  // only in auth.secret_names — map those into the same widget shape.
  const settingFields = fields.filter((f) => f.kind !== "secret");
  const secretFields: {
    name: string;
    label: string;
    widget: {
      kind: "password" | "text" | "email" | "textarea";
      placeholder?: string;
    };
    required: boolean;
    help?: string | null;
  }[] = [
    ...fields
      .filter((f) => f.kind === "secret")
      .map((f) => ({
        name: f.name,
        label: f.label ?? secretWidget(f.name).label,
        widget: secretWidget(f.name),
        required: f.required ?? false,
        help: f.help,
      })),
    ...secretNames
      .filter((n) => !fields.some((f) => f.name === n))
      .map((n) => ({
        name: n,
        label: secretWidget(n).label,
        widget: secretWidget(n),
        required: true,
        help: null,
      })),
  ];

  const fail = (e: unknown, title: string) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    toast.error(title, { description: msg });
  };

  /** Builds the config to persist from the current form state. Keys the
   * schema does not know (legacy fields, tool_policy) survive the merge. */
  const buildConfig = (): Record<string, unknown> => {
    let cfg: Record<string, unknown>;
    if (isMcp) {
      const advanced = JSON.parse(advancedText || "{}") as Record<
        string,
        unknown
      >;
      cfg = {
        ...advanced,
        mcp: {
          ...(initialConfig.mcp as Record<string, unknown>),
          url: mcpUrl.trim(),
        },
      };
    } else {
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
    }
    const clean = cleanPolicy(policy);
    if (Object.keys(clean).length > 0) cfg.tool_policy = clean;
    else if (isMcp) delete cfg.tool_policy;
    return cfg;
  };

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const cfg = buildConfig();
      const secretsPayload = Object.fromEntries(
        Object.entries(secretDraft).filter(([, v]) => v !== ""),
      );
      await api("PUT", `/api/v1/admin/integrations/${id}`, {
        config: cfg,
        enabled,
        secrets: secretsPayload,
      });
      toast.success("Integration saved", { description: name });
      setSecretDraft({});
      onChanged();
    } catch (e) {
      fail(
        e instanceof SyntaxError
          ? new Error(`advanced config is not valid JSON: ${e.message}`)
          : e,
        "Save failed",
      );
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
          enabled
            ? "Enabled — tools join the chat loop."
            : "Disabled; the configuration is kept, no tools are contributed."
        }
        back={{ label: "Integrations", onClick: onBack }}
        actions={
          <>
            <Button disabled={!dirty || busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setState(initial)}>
                Reset
              </Button>
            )}
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

      {/* Type + enable toggle: one compact row, the page itself is the form. */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Type
          </span>
          <Badge variant="secondary">{categoryLabel(category)}</Badge>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-foreground"
            checked={enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span className="text-muted-foreground">Enabled</span>
        </label>
      </div>

      {/* Settings: the manifest-declared fields, edited in place. */}
      {settingFields.map((f) => (
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
                  patch({ draft: { ...draft, [f.name]: e.target.checked } })
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
                patch({ draft: { ...draft, [f.name]: e.target.value } })
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
                patch({ draft: { ...draft, [f.name]: e.target.value } })
              }
            />
          )}
        </Field>
      ))}

      {secretFields.map((sf) => {
        const stored = secrets?.find((x) => x.name === sf.name) ?? null;
        const value = secretDraft[sf.name] ?? "";
        return (
          <Field
            key={sf.name}
            label={`${sf.label}${sf.required ? " *" : ""}`}
            hint={
              stored ? "Leave blank to keep the current one." : "Not stored yet"
            }
          >
            {sf.widget.kind === "textarea" ? (
              <Textarea
                className="min-h-20 max-w-xl font-mono text-xs"
                spellCheck={false}
                placeholder={stored ? "••••••••" : sf.widget.placeholder}
                value={value}
                onChange={(e) =>
                  setSecretDraft((d) => ({ ...d, [sf.name]: e.target.value }))
                }
              />
            ) : (
              <Input
                className="max-w-md font-mono text-xs"
                type={sf.widget.kind === "text" ? "text" : "password"}
                spellCheck={false}
                placeholder={
                  stored ? "••••••••" : (sf.widget.placeholder ?? "required")
                }
                value={value}
                onChange={(e) =>
                  setSecretDraft((d) => ({ ...d, [sf.name]: e.target.value }))
                }
              />
            )}
          </Field>
        );
      })}

      {isMcp && (
        <>
          <Field label="Server URL" hint="Streamable-HTTP MCP endpoint.">
            <Input
              type="text"
              className="max-w-md font-mono text-xs"
              spellCheck={false}
              placeholder="https://mcp.example.com/mcp"
              value={mcpUrl}
              onChange={(e) => patch({ mcpUrl: e.target.value })}
            />
          </Field>
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
                            patch({ policy: toggleClass(policy, role, cls) })
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
          <Field
            label="Advanced config (JSON)"
            hint="Everything beyond the server URL and tool policy."
          >
            <Textarea
              className="min-h-24 font-mono text-xs"
              spellCheck={false}
              value={advancedText}
              onChange={(e) => patch({ advancedText: e.target.value })}
            />
          </Field>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

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
    </div>
  );
}

function fieldLabel(f: FieldSpec): string {
  return f.label ?? f.name.replace(/_/g, " ");
}
