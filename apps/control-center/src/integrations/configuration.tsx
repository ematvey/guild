// The Configuration tab of an installed integration: the settings form
// generated from the manifest's fields, each credential write-only with a
// masked preview, and beside every field the plugin's own note on where the
// value comes from. An MCP server adds its URL and advanced config. Who may
// use the integration is the Access tab. Save runs the integration's connection test first: a broken
// connection is never stored.

import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Textarea } from "@guild/ui/components/textarea";
import { useCachedGet } from "../../../desktop/src/views/settings/use-cached-api";
import { integrationSecretsPath, updateIntegration } from "../../../desktop/src/lib/api/settings";
import { testIntegration, type FieldSpec, type ShopItem, type TestDraft, type TestResult } from "./integrations-api";
import { INSTANCE_SLUG } from "./model";
import { Note } from "./prose";

interface SecretEntry {
  name: string;
  updated_at: string;
  masked?: string;
}

export const fieldLabel = (f: FieldSpec): string => f.label ?? f.name.replace(/_/g, " ");

const SECRET_WIDGETS: Record<string, { label: string; kind: "password" | "text" | "email" | "textarea" }> = {
  token: { label: "API token", kind: "password" },
  api_key: { label: "API key", kind: "password" },
  bot_token: { label: "Bot token", kind: "password" },
  secret_key: { label: "Secret key", kind: "password" },
  public_key: { label: "Public key", kind: "text" },
  email: { label: "Email", kind: "email" },
  admin_email: { label: "Admin email", kind: "email" },
  site: { label: "Site URL", kind: "text" },
  host: { label: "Host URL", kind: "text" },
  service_account_json: { label: "Service account JSON", kind: "textarea" },
};

const secretWidget = (name: string) =>
  SECRET_WIDGETS[name] ?? {
    label: name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    kind: "password" as const,
  };

export interface ConfigDraft {
  draft: Record<string, unknown>;
  mcpUrl: string;
  advancedText: string;
}

export function initialDraft(fields: FieldSpec[], config: Record<string, unknown>, isMcp: boolean): ConfigDraft {
  const advanced: Record<string, unknown> = {};
  if (isMcp) {
    for (const [k, v] of Object.entries(config)) {
      if (k !== "mcp" && k !== "tools") advanced[k] = v;
    }
  }
  return {
    draft: Object.fromEntries(
      fields
        .filter((f) => f.kind !== "secret")
        .map((f) => [f.name, config[f.name] ?? f.default ?? (f.kind === "boolean" ? false : "")]),
    ),
    mcpUrl: isMcp ? String((config.mcp as Record<string, unknown> | undefined)?.url ?? "") : "",
    advancedText: isMcp ? JSON.stringify(advanced, null, 2) : "",
  };
}

/** The config a save persists, from the form state over the stored row.
 *  Credentials never ride in config (they are secrets); keys the schema
 *  does not know survive the merge. Throws on a missing required value or
 *  unreadable advanced JSON. */
export function buildIntegrationConfig(
  fields: FieldSpec[],
  stored: Record<string, unknown>,
  form: ConfigDraft,
  isMcp: boolean,
): Record<string, unknown> {
  let cfg: Record<string, unknown>;
  if (isMcp) {
    let advanced: Record<string, unknown>;
    try {
      advanced = JSON.parse(form.advancedText || "{}") as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Advanced config is not valid JSON: ${(e as Error).message}`);
    }
    cfg = { ...advanced, mcp: { ...(stored.mcp as Record<string, unknown>), url: form.mcpUrl.trim() } };
  } else {
    cfg = { ...stored };
  }
  for (const f of fields) {
    if (f.kind === "secret") {
      delete cfg[f.name];
      continue;
    }
    const value = form.draft[f.name];
    if (f.kind === "boolean") {
      cfg[f.name] = value === true;
    } else if (f.kind === "number") {
      const n = Number(value);
      if (value === "" || value === null || value === undefined || Number.isNaN(n)) {
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
  delete cfg.tool_policy;
  return cfg;
}

/** One form row: the control on the left, the plugin's note on where the
 *  value comes from on the right (stacked on a narrow pane). */
function FieldRow({
  id,
  label,
  required,
  hint,
  obtain,
  children,
}: {
  id: string;
  label: string;
  required: boolean;
  hint?: string | null;
  obtain?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-x-10 gap-y-3 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="min-w-0">
        <label htmlFor={id} className="mb-1.5 flex items-baseline gap-2 text-sm font-medium">
          {label}
          {!required && <span className="text-xs font-normal text-muted-foreground">Optional</span>}
        </label>
        {children}
        {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {obtain ? (
        <div className="min-w-0 border-l border-border pl-4 lg:mt-6">
          <p className="mb-1 text-xs font-medium text-foreground">How to get it</p>
          <Note markdown={obtain} />
        </div>
      ) : (
        <div className="hidden lg:block" />
      )}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>}
      <div className="mt-2 divide-y divide-border border-y border-border">{children}</div>
    </section>
  );
}

/** Tests the stored configuration; with `draft`, the form's unsaved
 *  values are tested in its place and nothing is saved. */
export function TestConnectionButton({
  id,
  disabled,
  draft,
}: {
  id: string;
  disabled?: boolean;
  draft?: () => TestDraft;
}) {
  const [state, setState] = useState<"idle" | "running" | TestResult>("idle");
  const run = async () => {
    setState("running");
    try {
      setState(await testIntegration(id, draft?.() ?? {}));
    } catch (e) {
      setState({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <Button variant="outline" onClick={run} disabled={disabled || state === "running"}>
        {state === "running" ? <Loader2 className="size-4 animate-spin" /> : null}
        Test connection
      </Button>
      {typeof state === "object" &&
        (state.ok ? (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4" /> Connected in {state.ms} ms
          </span>
        ) : (
          <span role="alert" className="flex min-w-0 items-start gap-1.5 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />{" "}
            <span className="min-w-0 break-words">{state.error}</span>
          </span>
        ))}
    </div>
  );
}

export function ConfigurationTab({
  item,
  onSaved,
}: {
  item: ShopItem;
  /** Called with the stored slug after a save: a rename changes the URL. */
  onSaved: (name: string) => void;
}) {
  const id = item.id!;
  const fields = item.settings?.fields ?? [];
  const isMcp = typeof item.config?.mcp === "object" && item.config.mcp !== null;
  const [initial] = useState(() => initialDraft(fields, item.config, isMcp));
  const [form, setForm] = useState(initial);
  const [identity, setIdentity] = useState({ name: item.name, label: item.label });
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secretsRes = useCachedGet<{ secrets: SecretEntry[] }>(integrationSecretsPath(id));
  const stored = secretsRes.data?.secrets ?? null;

  const identityDirty = identity.name !== item.name || identity.label !== item.label;
  const dirty =
    JSON.stringify(form) !== JSON.stringify(initial) ||
    Object.values(secretDraft).some((v) => v !== "") ||
    identityDirty;
  // A save error names the field that failed; the next keystroke may fix it,
  // so editing clears the message instead of leaving a stale verdict.
  const patchDraft = (name: string, value: unknown) => {
    setError(null);
    setForm((f) => ({ ...f, draft: { ...f.draft, [name]: value } }));
  };
  const patchSecret = (name: string, value: string) => {
    setError(null);
    setSecretDraft((d) => ({ ...d, [name]: value }));
  };

  const settingFields = fields.filter((f) => f.kind !== "secret");
  const secretFields: FieldSpec[] = [
    ...fields.filter((f) => f.kind === "secret"),
    ...item.secret_names
      .filter((n) => !fields.some((f) => f.name === n))
      .map((n) => ({ name: n, kind: "secret", label: secretWidget(n).label, required: true })),
  ];

  const draftForTest = (): TestDraft =>
    dirty
      ? {
          config: buildIntegrationConfig(fields, item.config, form, isMcp),
          secrets: Object.fromEntries(Object.entries(secretDraft).filter(([, v]) => v !== "")),
        }
      : {};

  const save = async () => {
    if (busy || !dirty) return;
    const slug = identity.name.trim();
    if (identityDirty && !INSTANCE_SLUG.test(slug)) {
      setError("The slug must start with a letter or digit and use only a-z, 0-9, _ and -, up to 48 chars.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const config = buildIntegrationConfig(fields, item.config, form, isMcp);
      const secrets = Object.fromEntries(Object.entries(secretDraft).filter(([, v]) => v !== ""));
      const stored = await updateIntegration(id, {
        config,
        secrets,
        ...(identityDirty ? { name: identity.name.trim(), label: identity.label.trim() } : {}),
      });
      toast.success("Changes saved", { description: stored.label || item.title });
      setSecretDraft({});
      onSaved(stored.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-28">
      <Section
        title="Name"
        description="What this instance is called in the panel, and the slug its tool names start with."
      >
        <FieldRow id="instance-label" label="Name" required={false} hint="Shown in the integrations panel.">
          <Input
            id="instance-label"
            value={identity.label}
            placeholder={item.title}
            onChange={(e) => {
              setError(null);
              setIdentity((v) => ({ ...v, label: e.target.value }));
            }}
          />
        </FieldRow>
        <FieldRow
          id="instance-name"
          label="Slug"
          required={false}
          hint="Lowercase letters, digits, dashes and underscores. Tools are named <slug>_<tool>; renaming moves them."
        >
          <Input
            id="instance-name"
            className="font-mono text-xs"
            maxLength={48}
            value={identity.name}
            onChange={(e) => {
              setError(null);
              setIdentity((v) => ({ ...v, name: e.target.value.trim().toLowerCase() }));
            }}
          />
        </FieldRow>
      </Section>
      {settingFields.length > 0 && (
        <Section title="Settings">
          {settingFields.map((f) => {
            const fid = `field-${f.name}`;
            const value = form.draft[f.name];
            return (
              <FieldRow
                key={f.name}
                id={fid}
                label={fieldLabel(f)}
                required={f.required === true}
                hint={f.help}
                obtain={f.obtain}
              >
                {f.kind === "boolean" ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      id={fid}
                      type="checkbox"
                      className="size-4 accent-foreground"
                      checked={value === true}
                      onChange={(e) => patchDraft(f.name, e.target.checked)}
                    />
                    <span className="text-muted-foreground">On</span>
                  </label>
                ) : f.kind === "text" ? (
                  <Textarea
                    id={fid}
                    className="min-h-24"
                    spellCheck={false}
                    placeholder={f.placeholder ?? undefined}
                    value={String(value ?? "")}
                    onChange={(e) => patchDraft(f.name, e.target.value)}
                  />
                ) : (
                  <Input
                    id={fid}
                    type={f.kind === "number" ? "number" : "text"}
                    spellCheck={false}
                    placeholder={
                      f.placeholder ?? (f.default !== undefined && f.default !== null ? String(f.default) : undefined)
                    }
                    value={String(value ?? "")}
                    onChange={(e) => patchDraft(f.name, e.target.value)}
                  />
                )}
              </FieldRow>
            );
          })}
        </Section>
      )}

      {secretFields.length > 0 && (
        <Section
          title="Credentials"
          description="Stored encrypted on the server and never shown again. Leave a field empty to keep the current value."
        >
          {secretFields.map((f) => {
            const fid = `secret-${f.name}`;
            const have = stored?.find((s) => s.name === f.name) ?? null;
            const widget = secretWidget(f.name);
            const value = secretDraft[f.name] ?? "";
            const placeholder = have ? have.masked || "••••••••" : (f.placeholder ?? "Not set");
            return (
              <FieldRow
                key={f.name}
                id={fid}
                label={f.label ?? widget.label}
                required={f.required !== false}
                hint={have ? `Stored ${new Date(have.updated_at).toLocaleDateString()}` : (f.help ?? "Not stored yet")}
                obtain={f.obtain}
              >
                {widget.kind === "textarea" ? (
                  <Textarea
                    id={fid}
                    className="min-h-28 font-mono text-xs"
                    spellCheck={false}
                    placeholder={placeholder}
                    value={value}
                    onChange={(e) => patchSecret(f.name, e.target.value)}
                  />
                ) : (
                  <Input
                    id={fid}
                    className="font-mono text-xs"
                    type={widget.kind === "text" || widget.kind === "email" ? widget.kind : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={placeholder}
                    value={value}
                    onChange={(e) => patchSecret(f.name, e.target.value)}
                  />
                )}
              </FieldRow>
            );
          })}
        </Section>
      )}

      {isMcp && (
        <>
          <Section title="Server">
            <FieldRow id="mcp-url" label="Server URL" required hint="A streamable-HTTP MCP endpoint.">
              <Input
                id="mcp-url"
                className="font-mono text-xs"
                spellCheck={false}
                placeholder="https://mcp.example.com/mcp"
                value={form.mcpUrl}
                onChange={(e) => setForm((f) => ({ ...f, mcpUrl: e.target.value }))}
              />
            </FieldRow>
          </Section>
          <Section title="Advanced" description="Everything beyond the server URL, as JSON.">
            <div className="py-5">
              <Textarea
                aria-label="Advanced config"
                className="min-h-28 font-mono text-xs"
                spellCheck={false}
                value={form.advancedText}
                onChange={(e) => setForm((f) => ({ ...f, advancedText: e.target.value }))}
              />
            </div>
          </Section>
        </>
      )}

      {settingFields.length === 0 && secretFields.length === 0 && !isMcp && (
        <p className="text-sm text-muted-foreground">This integration has nothing to configure.</p>
      )}

      <div className="sticky bottom-0 -mx-1 mt-8 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 px-1 py-4 backdrop-blur">
        <Button onClick={save} disabled={!dirty || busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? "Testing and saving…" : "Save changes"}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            onClick={() => {
              setForm(initial);
              setSecretDraft({});
              setIdentity({ name: item.name, label: item.label });
              setError(null);
            }}
          >
            Discard
          </Button>
        )}
        <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
        <TestConnectionButton id={id} disabled={busy} draft={draftForTest} />
        {error !== null && (
          <p role="alert" className="basis-full text-sm text-destructive">
            {error}
          </p>
        )}
        {dirty && error === null && (
          <p className="basis-full text-xs text-muted-foreground">
            Saving checks the connection with your changes first. Test connection checks what is saved now.
          </p>
        )}
      </div>
    </div>
  );
}
