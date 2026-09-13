//! IntegrationsSection — admin settings: a list screen of available and
//! configured integrations; the detail screen (addressed by the row's id,
//! /settings/integrations/<id>) holds the enable toggle, JSON config
//! editor, save and delete. MCP plugin rows additionally show the mcp url,
//! secret names with timestamps, a write-only secret form, and a per-role
//! tool-policy editor.

import { useState } from "react";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import {
  ArrowLeft,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";

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
  fetch: "Fetch providers",
  search: "Search providers",
  other: "Other",
  mcp: "MCP plugins",
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

const backBtn =
  "mb-4 flex items-center gap-1.5 text-base text-muted-foreground transition-colors hover:text-foreground";
const listCard =
  "flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40";
const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

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

  const [actionError, setActionError] = useState<string | null>(null);

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
          <button className={backBtn} onClick={() => onDetailChange(null)}>
            <ArrowLeft className="size-4" /> Integrations
          </button>
          <p className="text-base text-muted-foreground">
            This integration no longer exists.
          </p>
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

  const availableNames = new Set((available ?? []).map((a) => a.name));

  /// Opens a detail page by id. A not-yet-configured connector has no row
  /// (and no id) yet: creating its configuration is the first click's job —
  /// the row starts disabled and the navigation lands on its id.
  const openIntegration = async (name: string, rowId: string | null) => {
    setActionError(null);
    if (rowId) {
      onDetailChange(rowId);
      return;
    }
    try {
      const created = await api<{ id: string }>("POST", "/api/v1/admin/integrations", {
        name,
      });
      reload();
      onDetailChange(created.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      {error && <p className="text-base text-destructive">{error}</p>}
      {actionError && <p className="text-base text-destructive">{actionError}</p>}
      {rows === null || available === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : (
        (["fetch", "search", "other", "mcp"] as const).map((cat) => {
          // Rows carry their category from the API; available entries hold
          // the catalog category of kinds with no configured row yet.
          const rowItems = (rows ?? []).filter((r) => (r.category ?? "other") === cat);
          const availItems = available.filter((a) => (a.category ?? "other") === cat);
          if (rowItems.length === 0 && availItems.length === 0) return null;
          return (
            <section key={cat}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className={label}>{categoryLabel(cat)}</h3>
                <span className="text-xs text-muted-foreground">
                  {rowItems.filter((r) => r.enabled).length} enabled
                </span>
              </div>
              <div className="space-y-2">
                {rowItems.map((r) => (
                  <button
                    key={r.id}
                    className={listCard}
                    onClick={() => onDetailChange(r.id)}
                  >
                    <Webhook className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{r.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.enabled ? "enabled" : "configured, disabled"}
                      </p>
                    </div>
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        r.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"
                      }`}
                    />
                    <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
                  </button>
                ))}
                {availItems.map((a) => (
                  <button
                    key={`available-${a.name}`}
                    className={listCard}
                    onClick={() => openIntegration(a.name, null)}
                  >
                    <Webhook className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{a.name}</p>
                      <p className="text-xs text-muted-foreground">not configured</p>
                    </div>
                    <Plus className="size-3.5 shrink-0 text-muted-foreground/60" />
                  </button>
                ))}
              </div>
            </section>
          );
        })
      )}
      {availableNames.size === 0 && (rows ?? []).length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-base text-muted-foreground">
          No integrations are available in this build.
        </p>
      )}
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
      onChanged();
      setMode("view");
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? `config is not valid JSON: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
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
      setSecretName("");
      setSecretValue("");
      reloadSecrets();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      setConfirmSecret(null);
      onChanged();
      reloadSecrets();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button className={backBtn} onClick={onBack}>
        <ArrowLeft className="size-4" /> Integrations
      </button>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-base font-semibold">{name}</h3>
        <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
          {categoryLabel(category)}
        </span>
        <span
          className={`size-2 rounded-full ${initialEnabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
          title={initialEnabled ? "enabled" : "disabled"}
        />
      </div>

      {mode === "edit" ? (
        <div className="mt-4 max-w-xl space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
            <label className="flex flex-1 items-center gap-3 text-base">
              <input
                type="checkbox"
                className="size-4 accent-foreground"
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
          </div>

          <div>
            <p className={label}>Config (JSON)</p>
            <Textarea
              className="mt-1.5 min-h-40 font-mono text-xs"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          {isMcp && (
            <div>
              <p className={label}>Tool policy (saved into config.tool_policy)</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Classes each role may call; unchecked roles get the manifest defaults.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {ROLES.map((role) => (
                  <div key={role} className="rounded-lg border border-border px-3 py-2">
                    <p className="text-base font-medium capitalize">{role}</p>
                    <div className="mt-1 space-y-1">
                      {TOOL_CLASSES.map((cls) => (
                        <label key={cls} className="flex items-center gap-2 text-base">
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
            </div>
          )}

          {error && <p className="text-base text-destructive">{error}</p>}
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
      ) : (
        // view: saved facts + explicit actions
        <div className="mt-4 max-w-xl space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className={label}>Status</p>
            <p className="mt-1 text-base">
              {initialEnabled ? "Enabled — tools join the chat loop" : "Configured, disabled"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Disabled integrations keep their config but contribute no tools.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className={label}>Config</p>
            <pre className="mt-1 overflow-x-auto font-mono text-xs">
              {JSON.stringify(initialConfig, null, 2)}
            </pre>
          </div>

          {isMcp && (
            <div className="rounded-lg border border-border bg-card p-4">
              <p className={label}>Connection</p>
              <p className="mt-1 font-mono text-xs break-all">
                {String((initialConfig.mcp as Record<string, unknown>).url ?? "(no url)")}
              </p>
            </div>
          )}

          {isMcp && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-1.5">
                <KeyRound className="size-3.5 text-muted-foreground" />
                <p className={label}>Secrets</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Passed to the MCP server as headers on connect; values are
                never shown or returned by the API.
              </p>
              {secrets === null ? (
                <Skeleton className="mt-2 h-8 w-56" />
              ) : secrets.length === 0 ? (
                <p className="mt-2 text-base text-muted-foreground">No secrets stored.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {secrets.map((s) =>
                    confirmSecret === s.name ? (
                      <li key={s.name} className="flex items-center gap-2 text-base">
                        <span className="font-mono text-xs">{s.name}</span>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => deleteSecret(s.name)}
                        >
                          Delete secret
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmSecret(null)}>
                          Cancel
                        </Button>
                      </li>
                    ) : (
                      <li key={s.name} className="flex items-center gap-2 text-base">
                        <span className="font-mono text-xs">{s.name}</span>
                        <span className="text-xs text-muted-foreground">
                          updated {new Date(s.updated_at).toLocaleString()}
                        </span>
                        <button
                          className="text-xs text-muted-foreground transition-colors hover:text-destructive"
                          onClick={() => setConfirmSecret(s.name)}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              )}
              <div className="mt-3 flex items-end gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">Name</p>
                  <Input
                    className="h-8 w-40 font-mono text-xs"
                    value={secretName}
                    onChange={(e) => setSecretName(e.target.value)}
                    placeholder="e.g. api_key"
                  />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Value (write-only)</p>
                  <Input
                    className="h-8 w-56 font-mono text-xs"
                    type="password"
                    value={secretValue}
                    onChange={(e) => setSecretValue(e.target.value)}
                    placeholder="add or replace"
                  />
                </div>
                <Button size="sm" disabled={busy || !secretName.trim() || !secretValue} onClick={saveSecret}>
                  {busy ? "Saving…" : "Save secret"}
                </Button>
              </div>
            </div>
          )}

          {isMcp && (
            <div className="rounded-lg border border-border bg-card p-4">
              <p className={label}>Tool policy</p>
              {Object.keys(cleanPolicy(readPolicy(initialConfig))).length === 0 ? (
                <p className="mt-1 text-base text-muted-foreground">
                  Default — manifest tool classes apply to every role.
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {ROLES.map((role) => {
                    const classes = readPolicy(initialConfig)[role];
                    if (!classes?.length) return null;
                    return (
                      <div key={role}>
                        <p className="text-base font-medium capitalize">{role}</p>
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

          {error && <p className="text-base text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button onClick={() => setMode("edit")}>
              <Pencil className="mr-1 size-3.5" /> Edit
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api("DELETE", `/api/v1/admin/integrations/${id}`);
                      onBack();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Remove configuration
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-1 size-3.5" /> Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
