//! AddOrgMcp — the integrations page's "Connect an MCP server" page
//! (/integrations/connect/mcp). An admin names a remote MCP server for
//! the whole organization: URL, credential headers (write-only values, each
//! stored as an encrypted secret), and whether Guild's identity headers ride
//! along. Connect lists the server's tools with a suggested class; the admin
//! picks which tools to turn on and at what class, and Add creates the
//! enabled integration in one step.

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Textarea } from "@guild/ui/components/textarea";
import { createOrgMcp, probeOrgMcp } from "../../lib/api/settings";
import { Field } from "../settings/components/field";

type ToolClass = "read" | "write" | "admin";

interface ProbedTool {
  name: string;
  description: string;
  class: ToolClass;
}

interface ToolChoice extends ProbedTool {
  enabled: boolean;
}

interface HeaderDraft {
  name: string;
  value: string;
}

/** A slug from the display name: lowercase, runs of anything else folded to
 *  `-`, at most 48 characters. */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const CLASS_HINT: Record<ToolClass, string> = {
  read: "members and admins",
  write: "admins (members by policy)",
  admin: "admins only",
};

export function AddOrgMcp({ onCreated }: { onCreated: (slug: string) => void }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [headers, setHeaders] = useState<HeaderDraft[]>([{ name: "Authorization", value: "" }]);
  const [envelope, setEnvelope] = useState(true);
  const [tools, setTools] = useState<ToolChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A changed connection invalidates the discovered tools.
  useEffect(() => {
    setTools(null);
  }, [url, headers, envelope]);

  const effectiveSlug = slugEdited ? slug : slugFromTitle(title);
  const connection = () => ({
    url: url.trim(),
    headers: headers.filter((h) => h.name.trim() !== "" || h.value !== ""),
    envelope,
  });

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await probeOrgMcp<{ tools: ProbedTool[] }>(connection());
      setTools(res.tools.map((t) => ({ ...t, enabled: true })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (tools === null) return;
    setBusy(true);
    setError(null);
    try {
      await createOrgMcp({
        slug: effectiveSlug,
        label: title.trim(),
        title: title.trim(),
        description: description.trim(),
        ...connection(),
        tools: tools.map((t) => ({ name: t.name, enabled: t.enabled, class: t.class })),
      });
      toast.success("MCP server added", { description: title.trim() || effectiveSlug });
      onCreated(effectiveSlug);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const patchTool = (name: string, patch: Partial<ToolChoice>) =>
    setTools((prev) => prev?.map((t) => (t.name === name ? { ...t, ...patch } : t)) ?? null);

  const enabledCount = tools?.filter((t) => t.enabled).length ?? 0;

  return (
    <div className="max-w-3xl space-y-5">
      <p className="max-w-prose text-sm text-muted-foreground">
        Connect a remote MCP server for the whole organization. Its tools reach every chat the integration policy
        allows.
      </p>

      <div className="space-y-4 rounded-lg border border-border bg-card p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Shown on the integrations page.">
            <Input value={title} placeholder="Internal docs" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Slug" hint={`Tools reach the model as ${effectiveSlug || "<slug>"}_<tool>.`}>
            <Input
              className="font-mono"
              value={effectiveSlug}
              placeholder="internal-docs"
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
            />
          </Field>
        </div>
        <Field label="Server URL" hint="A streamable-HTTP MCP endpoint. Internal addresses are allowed.">
          <Input
            className="font-mono"
            value={url}
            placeholder="https://mcp.example.com/mcp"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Description" hint="What the server is for. Agents read it when they decide to use its tools.">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div>
          <p className="mb-1.5 text-sm font-medium leading-none">Headers</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Sent with every request, for example <span className="font-mono">Authorization: Bearer …</span>. Values are
            stored encrypted and never shown again.
          </p>
          <div className="space-y-2">
            {headers.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="w-48 font-mono"
                  placeholder="Header name"
                  value={h.name}
                  onChange={(e) => setHeaders(headers.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                />
                <Input
                  className="flex-1"
                  type="password"
                  placeholder="Value"
                  value={h.value}
                  onChange={(e) => setHeaders(headers.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove header"
                  onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setHeaders([...headers, { name: "", value: "" }])}>
              <Plus className="mr-1 size-3" /> Add header
            </Button>
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-foreground"
            checked={envelope}
            onChange={(e) => setEnvelope(e.target.checked)}
          />
          <span>
            Send Guild identity headers
            <span className="block text-xs text-muted-foreground">
              <span className="font-mono">x-guild-org</span>, <span className="font-mono">x-guild-caller</span> and{" "}
              <span className="font-mono">x-guild-acting-as</span> tell the server who is calling. Turn off for a
              third-party server.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-2">
          <Button
            variant={tools === null ? "default" : "outline"}
            onClick={connect}
            disabled={busy || url.trim() === ""}
          >
            {busy && tools === null ? "Connecting…" : tools === null ? "Connect" : "Reconnect"}
          </Button>
          {tools !== null && (
            <span className="text-xs text-muted-foreground">
              Connected — {tools.length} {tools.length === 1 ? "tool" : "tools"}
            </span>
          )}
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      {tools !== null && (
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-3">
            <p className="text-sm font-medium">Tools</p>
            <p className="text-xs text-muted-foreground">
              Pick the tools chats may use and their class. The class decides who may call a tool: read reaches members,
              write and admin need more. Suggested from the server's hints and the tool name.
            </p>
          </div>
          {tools.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">The server exposes no tools.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {tools.map((t) => (
                <li key={t.name} className="flex items-center gap-3 px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={`Enable ${t.name}`}
                    className="size-4 shrink-0 accent-foreground"
                    checked={t.enabled}
                    onChange={(e) => patchTool(t.name, { enabled: e.target.checked })}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="truncate font-mono text-xs">{t.name}</span>
                    {t.description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.description}</p>}
                  </div>
                  <select
                    aria-label={`Class of ${t.name}`}
                    title={`Callable by ${CLASS_HINT[t.class]}`}
                    className="h-8 shrink-0 rounded-md border border-border bg-card px-2 text-xs"
                    value={t.class}
                    onChange={(e) => patchTool(t.name, { class: e.target.value as ToolClass })}
                  >
                    <option value="read">Read</option>
                    <option value="write">Write</option>
                    <option value="admin">Admin</option>
                  </select>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {enabledCount} of {tools.length} enabled
            </span>
            <Button onClick={add} disabled={busy || effectiveSlug === ""}>
              {busy ? "Adding…" : "Add integration"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
