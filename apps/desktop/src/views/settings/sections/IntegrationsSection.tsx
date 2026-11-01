//! IntegrationsSection — the integration shop. The list is a card grid of
//! every integration the server ships or the registry approved: logo, title,
//! one-line summary, categories, and install state. Opening a card is the
//! install and configure flow: the detail page shows the long description,
//! adds the integration when the admin asks for it, and then renders the
//! settings form from the manifest field schema (no per-connector UI), the
//! secrets editor (masked previews, write-only values), and per-tool
//! curation (enable/disable + approval policy per declared tool).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../../theme";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import {
  createIntegration,
  deleteIntegration,
  integrationSecretsPath,
  integrationToolsPath,
  putIntegrationTool,
  SETTINGS_PATHS,
  updateIntegration,
} from "../../../lib/api/settings";
import { Check, ExternalLink, Plug, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { SkeletonRows, SkeletonForm } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";
import { PageHeader } from "../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "../components/empty-state";

/** One manifest-declared settings field — the detail form is generated
 *  from these; the manifest is the schema. */
interface FieldSpec {
  name: string;
  kind: string; // string | text | number | boolean | secret
  label?: string | null;
  required?: boolean;
  default?: unknown;
  help?: string | null;
  placeholder?: string | null;
}

/** One shop entry: the plugin's storefront metadata plus this org's install
 *  state. */
interface ShopItem {
  name: string;
  title: string;
  version: string;
  publisher: string;
  summary: string;
  description: string;
  docs_url: string | null;
  logo: string;
  categories: string[];
  traits: Record<string, string>;
  secret_names: string[];
  settings: { fields?: FieldSpec[] } | null;
  configured: boolean;
  id: string | null;
  org_id: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
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
  search: "Search",
  fetch: "Fetch",
  observability: "Observability",
  crm: "CRM",
  messaging: "Messaging",
  docs: "Docs",
  code: "Code",
  other: "Other",
  mcp: "MCP plugin",
};

const categoryLabel = (c?: string) => CATEGORY_LABELS[c ?? "other"] ?? c ?? "Other";

const TRAIT_LABELS: Record<string, string> = {
  web_search: "Web search",
  web_fetch: "Web fetch",
};

/** A data URL for an SVG document. `currentColor` is replaced by `color`
 *  first: an <img> does not inherit the page's text color. */
export function svgDataUrl(svg: string, color: string): string {
  const bytes = new TextEncoder().encode(svg.replaceAll("currentColor", color));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** The brand mark, drawn as an image so manifest markup never enters the
 *  DOM (no script, no handlers). A mark drawn in currentColor takes the
 *  surrounding foreground color, re-read on theme change. */
function Logo({ svg, size = "size-10" }: { svg: string; size?: string }) {
  const { theme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    // Next frame: the provider applies the theme class after this effect.
    const frame = requestAnimationFrame(() => {
      if (ref.current) setColor(getComputedStyle(ref.current).color);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, svg]);
  if (svg === "") {
    return (
      <div className={`${size} flex items-center justify-center rounded-lg bg-muted text-muted-foreground`}>
        <Plug className="size-5" />
      </div>
    );
  }
  return (
    <div ref={ref} className={`${size} flex shrink-0 items-center justify-center text-foreground`}>
      {color !== null && <img alt="" src={svgDataUrl(svg, color)} className="h-full w-full" />}
    </div>
  );
}

function StateBadge({ item }: { item: ShopItem }) {
  if (!item.configured) {
    return (
      <Badge variant="outline" className="border-transparent bg-accent text-muted-foreground">
        Not installed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-transparent bg-accent text-muted-foreground">
      <span
        className={`mr-1.5 inline-block size-1.5 rounded-full ${
          item.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"
        }`}
      />
      {item.enabled ? "Enabled" : "Disabled"}
    </Badge>
  );
}

function CategoryBadges({ categories }: { categories?: string[] }) {
  const list = categories?.length ? categories : ["other"];
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((c) => (
        <Badge key={c} variant="secondary">
          {categoryLabel(c)}
        </Badge>
      ))}
    </div>
  );
}

const ROLES: ToolRole[] = ["member", "admin"];

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

export default function IntegrationsSection({
  detail = null,
  onDetailChange,
}: SectionDetailProps) {
  const list = useCachedGet<{ items: ShopItem[] }>(SETTINGS_PATHS.integrations);
  const items = list.data?.items ?? null;
  const error = list.error;
  const reload = list.reload;
  const [query, setQuery] = useState("");

  const open = (slug: string | null) => onDetailChange(slug);

  const shown = useMemo(() => {
    if (items === null) return null;
    const q = query.trim().toLowerCase();
    if (q === "") return items;
    return items.filter((i) =>
      `${i.name} ${i.title} ${i.summary} ${i.categories.join(" ")}`.toLowerCase().includes(q),
    );
  }, [items, query]);

  if (detail !== null) {
    if (items === null) {
      if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
      return (
        <div className="space-y-2">
          <SkeletonForm />
        </div>
      );
    }
    const item = items.find((i) => i.name === detail) ?? null;
    if (item === null) {
      return (
        <div>
          <PageHeader title="Integrations" back={{ label: "Integrations", onClick: () => open(null) }} />
          <p className="text-sm text-muted-foreground">This integration is not available on this server.</p>
        </div>
      );
    }
    return (
      <IntegrationDetail
        key={item.name}
        item={item}
        onChanged={reload}
        onBack={() => {
          reload();
          open(null);
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect the tools your chats use. Each integration brings its own tools, its own settings, and its own credentials."
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="mb-4 max-w-sm">
        <Input
          type="search"
          placeholder="Search integrations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {shown === null ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <SkeletonRows rows={3} />
          <SkeletonRows rows={3} />
          <SkeletonRows rows={3} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Plug}
          title={query === "" ? "No integrations available" : "No matches"}
          hint={
            query === ""
              ? "This build ships no integrations and the registry has no approved plugins."
              : "Try another word."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((item) => (
            <button
              key={item.name}
              onClick={() => open(item.name)}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/60"
            >
              <div className="flex items-start gap-3">
                <Logo svg={item.logo} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.publisher}</p>
                </div>
              </div>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {item.summary}
              </p>
              <div className="mt-auto flex items-center justify-between gap-2">
                <CategoryBadges categories={item.categories} />
                {item.configured ? (
                  <StateBadge item={item} />
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Plus className="size-3.5" /> Add
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
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
 *  the form — one surface, no separate edit mode; dirty state drives
 *  Save. */
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

/** The storefront: what the integration is, what it needs, and — until it
 *  is installed — the one action the page offers. */
function Storefront({ item, onAdded }: { item: ShopItem; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await createIntegration({ name: item.name });
      toast.success("Integration added", { description: item.title });
      onAdded();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Could not add integration", { description: msg });
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Logo svg={item.logo} size="size-12" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{item.title}</h3>
              <span className="text-xs text-muted-foreground">v{item.version}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CategoryBadges categories={item.categories} />
              {Object.keys(item.traits).length > 0 && (
                <Badge variant="outline">
                  Provides {Object.keys(item.traits).map((t) => TRAIT_LABELS[t] ?? t).join(", ")}
                </Badge>
              )}
            </div>
          </div>
          <Button onClick={add} disabled={busy}>
            <Plus className="size-4" /> {busy ? "Adding…" : "Add integration"}
          </Button>
        </div>
        <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {item.description}
        </p>
        {item.docs_url !== null && (
          <a
            href={item.docs_url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" /> Documentation
          </a>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Adding it creates a disabled configuration. Fill the settings and credentials, then enable it.
      </p>
    </div>
  );
}

function IntegrationDetail({
  item,
  onChanged,
  onBack,
}: {
  item: ShopItem;
  onChanged: () => void;
  onBack: () => void;
}) {
  if (!item.configured) {
    return (
      <div>
        <PageHeader
          title={item.title}
          description={item.summary}
          back={{ label: "Integrations", onClick: onBack }}
        />
        <Storefront item={item} onAdded={onChanged} />
      </div>
    );
  }
  return <ConfiguredIntegration item={item} onChanged={onChanged} onBack={onBack} />;
}

function ConfiguredIntegration({
  item,
  onChanged,
  onBack,
}: {
  item: ShopItem;
  onChanged: () => void;
  onBack: () => void;
}) {
  const id = item.id!;
  const name = item.title;
  const initialConfig = item.config;
  const fields = item.settings?.fields ?? [];
  const isMcp =
    typeof item.config?.mcp === "object" && item.config.mcp !== null;
  const initial = useMemo(
    () => initialState(fields, initialConfig, item.enabled, isMcp),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialConfig, item.enabled, isMcp],
  );
  const [state, setState] = useState(initial);
  // A save triggers a list reload; the new row identity resets the form.
  useEffect(() => setState(initial), [initial]);

  const { enabled, draft, mcpUrl, advancedText, policy } = state;
  const patch = (p: Partial<typeof state>) => setState((s) => ({ ...s, ...p }));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});

  const secretsRes = useCachedGet<{ secrets: SecretEntry[] }>(integrationSecretsPath(id));
  const secrets = secretsRes.data?.secrets ?? null;

  const dirty =
    enabled !== initial.enabled ||
    JSON.stringify(draft) !== JSON.stringify(initial.draft) ||
    (isMcp && mcpUrl !== initial.mcpUrl) ||
    (isMcp && advancedText !== initial.advancedText) ||
    (isMcp && JSON.stringify(policy) !== JSON.stringify(initial.policy)) ||
    Object.values(secretDraft).some((v) => v !== "");

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
    ...item.secret_names
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
      const advanced = JSON.parse(advancedText || "{}") as Record<string, unknown>;
      cfg = {
        ...advanced,
        mcp: {
          ...(initialConfig.mcp as Record<string, unknown>),
          url: mcpUrl.trim(),
        },
      };
    } else {
      cfg = { ...initialConfig };
    }
    for (const f of fields) {
      if (f.kind === "secret") {
        delete cfg[f.name];
        continue;
      }
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
      await updateIntegration(id, {
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
      await deleteIntegration(id);
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
        title={item.title}
        description={enabled ? "Enabled — tools join the chat loop." : "Disabled; the configuration is kept, no tools are contributed."}
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

      {/* Identity + enable toggle: one compact row, the page itself is the form. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <Logo svg={item.logo} size="size-8" />
          <div>
            <p className="text-sm font-medium">{item.title}</p>
            <p className="text-xs text-muted-foreground">
              {item.publisher} · v{item.version}
            </p>
          </div>
          <CategoryBadges categories={item.categories} />
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
                onChange={(e) => patch({ draft: { ...draft, [f.name]: e.target.checked } })}
              />
              <span className="text-muted-foreground">Enabled</span>
            </label>
          ) : f.kind === "text" ? (
            <Textarea
              className="min-h-24"
              spellCheck={false}
              placeholder={f.placeholder ?? undefined}
              value={String(draft[f.name] ?? "")}
              onChange={(e) => patch({ draft: { ...draft, [f.name]: e.target.value } })}
            />
          ) : (
            <Input
              type={f.kind === "number" ? "number" : "text"}
              className="max-w-md"
              spellCheck={false}
              placeholder={
                f.placeholder ??
                (f.default !== undefined && f.default !== null ? String(f.default) : undefined)
              }
              value={String(draft[f.name] ?? "")}
              onChange={(e) => patch({ draft: { ...draft, [f.name]: e.target.value } })}
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
            hint={stored ? "Leave blank to keep the current one." : "Not stored yet"}
          >
            {sf.widget.kind === "textarea" ? (
              <Textarea
                className="min-h-20 max-w-xl font-mono text-xs"
                spellCheck={false}
                placeholder={stored ? stored.masked || "••••••••" : sf.widget.placeholder}
                value={value}
                onChange={(e) => setSecretDraft((d) => ({ ...d, [sf.name]: e.target.value }))}
              />
            ) : (
              <Input
                className="max-w-md font-mono text-xs"
                type={sf.widget.kind === "text" ? "text" : "password"}
                spellCheck={false}
                placeholder={
                  stored
                    ? stored.masked || "••••••••"
                    : (sf.widget.placeholder ?? "required")
                }
                value={value}
                onChange={(e) => setSecretDraft((d) => ({ ...d, [sf.name]: e.target.value }))}
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
                <div key={role} className="rounded-lg border border-border px-3 py-2.5">
                  <p className="text-sm font-medium capitalize">{role}</p>
                  <div className="mt-1.5 space-y-1.5">
                    {TOOL_CLASSES.map((cls) => (
                      <label key={cls} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-foreground"
                          checked={policy[role]?.includes(cls) ?? false}
                          onChange={() => patch({ policy: toggleClass(policy, role, cls) })}
                        />
                        <span className="capitalize text-muted-foreground">{cls}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Field>
          <Field label="Advanced config (JSON)" hint="Everything beyond the server URL and tool policy.">
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

      {Object.keys(item.traits).length > 0 && (
        <p className="text-xs text-muted-foreground">
          This integration provides the{" "}
          {Object.keys(item.traits).map((t) => TRAIT_LABELS[t] ?? t).join(" and ")}{" "}
          {Object.keys(item.traits).length === 1 ? "tool" : "tools"} under the shared name
          {Object.keys(item.traits).length === 1 ? "" : "s"}{" "}
          {Object.keys(item.traits)
            .map((t) => `“${t}”`)
            .join(", ")}
          . Only one enabled integration provides a given trait.
        </p>
      )}

      <ToolCuration id={id} isMcp={isMcp} />

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
    </div>
  );
}

function fieldLabel(f: FieldSpec): string {
  return f.label ?? f.name.replace(/_/g, " ");
}

// ---------- per-tool admin curation ----------

interface CuratedTool {
  name: string;
  tool: string;
  class: string;
  description: string;
  enabled: boolean;
  approval: "default" | "always_ask" | "always_allow";
}

interface ToolsResponse {
  resolved: boolean;
  kind?: string;
  reason?: string;
  tools: CuratedTool[];
}

/** The per-tool curation table: every tool the integration declares or
 *  serves, each with its enable toggle and approval policy (adapters spec
 *  §5/§6). Built-in rows read compiled-in declarations; MCP rows connect
 *  live — drift lands as disabled rows the admin flips on. */
function ToolCuration({ id, isMcp }: { id: string; isMcp: boolean }) {
  const res = useCachedGet<ToolsResponse>(integrationToolsPath(id));
  const data = res.data ?? null;
  const [busyTool, setBusyTool] = useState<string | null>(null);

  const update = async (tool: CuratedTool, patch: Partial<CuratedTool>) => {
    setBusyTool(tool.name);
    try {
      await putIntegrationTool(id, tool.name, {
        enabled: patch.enabled ?? tool.enabled,
        approval: patch.approval ?? tool.approval,
      });
      res.reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Could not update tool", { description: msg });
    } finally {
      setBusyTool(null);
    }
  };

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium">Tools</p>
          <p className="text-xs text-muted-foreground">
            {isMcp
              ? "Discovered live from the MCP server; unconfigured tools stay disabled."
              : "Declared by the integration; all are enabled unless you turn one off."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => res.reload()}>
          Refresh
        </Button>
      </div>
      {res.error ? (
        <div className="px-4 py-3">
          <p className="text-sm text-destructive">{res.error}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => res.reload()}>
            Retry
          </Button>
        </div>
      ) : data === null ? (
        <div className="space-y-2 p-4">
          <SkeletonRows rows={1} />
          <SkeletonRows rows={1} />
        </div>
      ) : !data.resolved ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {data.reason ?? "Tools are not resolved — enable the integration and save its settings first."}
        </p>
      ) : data.tools.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">The server exposes no tools.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {data.tools.map((t) => (
            <li key={t.name} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-xs">{t.name}</span>
                  <Badge variant="secondary" className="capitalize">
                    {t.class}
                  </Badge>
                  {TRAIT_LABELS[t.name] !== undefined && (
                    <Badge variant="outline" className="gap-1">
                      <Check className="size-3" /> Guild-provided
                    </Badge>
                  )}
                </div>
                {t.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.description}</p>
                )}
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-foreground"
                  disabled={busyTool === t.name}
                  checked={t.enabled}
                  onChange={(e) => update(t, { enabled: e.target.checked })}
                />
                Enabled
              </label>
              <select
                className="h-8 shrink-0 rounded-md border border-border bg-card px-2 text-xs"
                disabled={busyTool === t.name}
                value={t.approval}
                onChange={(e) =>
                  update(t, { approval: e.target.value as CuratedTool["approval"] })
                }
              >
                <option value="default">Follow user policy</option>
                <option value="always_ask">Always ask</option>
                <option value="always_allow">Always allow</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
