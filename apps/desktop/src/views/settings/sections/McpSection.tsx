//! McpSection — the user's own MCP servers: a data table with add, and a
//! detail page (addressed /settings/mcp/<id>) with the editable form,
//! header key/value editor (values write-only — the API returns masked
//! previews only), the live probe + tool table, the enable toggle, and
//! delete with confirm.

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { rowDetailCodec } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { registerSessionReset } from "../../../lib/session-reset";
import {
  createMcpServer,
  deleteMcpServer,
  probeMcpServer,
  probeMcpServerById,
  SETTINGS_PATHS,
  updateMcpServer,
} from "../../../lib/api/settings";
import { Plug, Plus, Trash2 } from "lucide-react";
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
import { SkeletonRows, SkeletonForm } from "@guild/ui/components/skeleton";
import { PageHeader } from "../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "../components/empty-state";

interface HeaderPreview {
  name: string;
  masked: string;
}

interface ServerRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  headers: HeaderPreview[];
}

interface ProbeResult {
  ok: boolean;
  tools?: { name: string; call_name?: string; description: string }[];
  error?: string;
}

/** Client-side cache of the last probe's tool count per server id — the
 *  list's tool-count column reads it; a fresh probe updates it. */
const toolCounts = new Map<string, number>();

registerSessionReset(() => toolCounts.clear());

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

/** One header editor row (key + write-only value). */
interface HeaderDraft {
  key: string;
  value: string;
}

function HeaderEditor({
  rows,
  previews,
  onChange,
}: {
  rows: HeaderDraft[];
  previews?: HeaderPreview[];
  onChange: (rows: HeaderDraft[]) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="w-48"
            placeholder="Header name"
            value={row.key}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
            }
          />
          <Input
            className="flex-1"
            type="password"
            placeholder={previews?.[i]?.masked ?? "value (write-only)"}
            value={row.value}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
            }
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <Plus className="mr-1 size-3" /> Add header
      </Button>
    </div>
  );
}

function headersPayload(rows: HeaderDraft[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.key.trim() !== "" && r.value !== "") out[r.key.trim()] = r.value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export default function McpSection({ detail = null, onDetailChange }: SectionDetailProps) {
  const list = useCachedGet<{ servers: ServerRow[] }>(SETTINGS_PATHS.mcpServers);
  const rows = list.data?.servers ?? null;
  const reload = list.reload;

  const [addOpen, setAddOpen] = useState(false);

  const columns = useMemo<ColumnDef<ServerRow, any>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Server",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <Plug className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{row.original.name}</span>
          </div>
        ),
      },
      {
        accessorKey: "url",
        header: "URL",
        cell: ({ row }) => (
          <span className="block max-w-[320px] truncate font-mono text-xs text-muted-foreground">
            {row.original.url}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge enabled={row.original.enabled} />,
      },
      {
        id: "tools",
        header: "Tools",
        cell: ({ row }) => {
          const count = toolCounts.get(row.original.id);
          return (
            <span className="text-xs text-muted-foreground">
              {count === undefined ? "—" : `${count}`}
            </span>
          );
        },
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.created_at.slice(0, 10)}
          </span>
        ),
      },
    ],
    [],
  );

  const view = rowDetailCodec.parse(detail);
  const open = (id: string | null) => onDetailChange(rowDetailCodec.format(id));

  if (view !== null) {
    if (rows === null) {
      if (list.error) return <p role="alert" className="text-sm text-destructive">{list.error}</p>;
      return (
        <div className="space-y-2">
          <SkeletonForm />
        </div>
      );
    }
    const server = rows.find((r) => r.id === view);
    if (!server) {
      return (
        <div>
          <PageHeader
            title="MCP servers"
            back={{ label: "MCP servers", onClick: () => open(null) }}
          />
          <p className="text-sm text-muted-foreground">This server no longer exists.</p>
        </div>
      );
    }
    return (
      <McpDetail
        key={server.id}
        server={server}
        onChanged={reload}
        onBack={() => open(null)}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="MCP servers"
        description="Tools from your enabled MCP servers are available in your chats."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 size-4" /> Add server
          </Button>
        }
      />
      {rows === null ? (
        list.error ? (
          <p className="text-sm text-destructive">{list.error}</p>
        ) : (
          <div className="space-y-2">
            <SkeletonRows rows={1} />
            <SkeletonRows rows={1} />
          </div>
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No MCP servers yet"
          hint="Add a streamable-HTTP MCP server; its tools are discovered per turn and declared to the model."
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1 size-4" /> Add server
            </Button>
          }
        />
      ) : (
        <DataTable columns={columns} data={rows} onRowClick={(row) => open(row.id)} />
      )}
      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(id) => {
          reload();
          setAddOpen(false);
          open(id);
        }}
      />
    </div>
  );
}

function AddServerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setProbe(null); }, [name, url, headers]);

  const reset = () => {
    setName("");
    setUrl("");
    setHeaders([]);
    setProbe(null);
  };

  const createServer = async (): Promise<string> => {
    const res = await createMcpServer<{ server: { id: string } }>({
      name,
      url,
      headers: headersPayload(headers),
    });
    return res.server.id;
  };

  const testConnection = async () => {
    setBusy(true);
    setProbe(null);
    try {
      const res = await probeMcpServer<ProbeResult>({ name, url, headers: headersPayload(headers) });
      setProbe(res);
    } catch (e) {
      setProbe({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      const id = await createServer();
      toast.success("MCP server added", { description: name });
      reset();
      onCreated(id);
    } catch (e) {
      toast.error("Could not add server", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>
            A streamable-HTTP MCP server. Private/loopback IP addresses are rejected unless the
            server allows them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name" hint="Use lowercase letters, numbers, underscores or hyphens.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-tools" />
          </Field>
          <Field label="URL" hint="http(s) streamable-HTTP endpoint.">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.test/mcp" />
          </Field>
          <Field label="Headers" hint="Sent on every request; values are encrypted at rest and write-only.">
            <HeaderEditor rows={headers} onChange={setHeaders} />
          </Field>
          {probe !== null && !probe.ok && (
            <p className="text-sm text-destructive">Test failed: {probe.error}</p>
          )}
          {probe !== null && probe.ok && (
            <p className="text-sm text-muted-foreground">
              Connected — {(probe.tools?.length ?? 0)} tools: {(probe.tools ?? []).map((t) => t.name).join(", ")}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy || name === "" || url === ""}
              onClick={testConnection}
            >
              Test connection
            </Button>
            <Button disabled={busy || name === "" || url === ""} onClick={finish}>
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function McpDetail({
  server,
  onChanged,
  onBack,
}: {
  server: ServerRow;
  onChanged: () => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(server.name);
  const [url, setUrl] = useState(server.url);
  const [enabled, setEnabled] = useState(server.enabled);
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const save = async (extra?: { enabled?: boolean }) => {
    setBusy(true);
    try {
      await updateMcpServer(server.id, {
        name,
        url,
        ...(headers.length > 0 ? { headers: headersPayload(headers) } : {}),
        ...(extra ?? {}),
      });
      setProbe(null);
      toolCounts.delete(server.id);
      toast.success("Saved", { description: name });
      onChanged();
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runProbe = async () => {
    setBusy(true);
    setProbe(null);
    try {
      const res = await probeMcpServerById<ProbeResult>(server.id);
      setProbe(res);
      if (res.ok && res.tools !== undefined) toolCounts.set(server.id, res.tools.length);
    } catch (e) {
      setProbe({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await deleteMcpServer(server.id);
      toast.success("MCP server deleted", { description: name });
      onChanged();
      onBack();
    } catch (e) {
      toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div>
      <PageHeader
        title={server.name}
        back={{ label: "MCP servers", onClick: onBack }}
        description={server.url}
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-foreground"
                checked={enabled}
                onChange={(e) => {
                  const v = e.target.checked;
                  setEnabled(v);
                  save({ enabled: v });
                }}
              />
              <span className="text-muted-foreground">Enabled</span>
            </label>
            <Button variant="outline" size="sm" disabled={busy} onClick={runProbe}>
              Test connection
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-1 size-4" /> Delete
            </Button>
          </div>
        }
      />
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Use lowercase letters, numbers, underscores or hyphens.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="URL">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Headers"
          hint={
            server.headers.length > 0
              ? `Stored: ${server.headers.map((h) => `${h.name}=${h.masked}`).join(", ")} — leave empty to keep them.`
              : "Optional; values are encrypted at rest and write-only."
          }
        >
          <HeaderEditor rows={headers} previews={server.headers} onChange={setHeaders} />
        </Field>
        <div className="flex justify-end">
          <Button size="sm" disabled={busy} onClick={() => save()}>
            Save changes
          </Button>
        </div>

        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2 text-sm font-medium">Tools</div>
          {probe === null ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Run “Test connection” to list the server's tools.
            </p>
          ) : !probe.ok ? (
            <p className="px-4 py-3 text-sm text-destructive">{probe.error}</p>
          ) : (probe.tools?.length ?? 0) === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">The server declares no tools.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {(probe.tools ?? []).map((t) => (
                  <tr key={t.name} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{t.call_name ?? t.name}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{t.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {server.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its tools stop being offered in your chats immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
