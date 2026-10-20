import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileImage,
  FileText,
  Folder,
  Link2,
  Loader2,
  Pencil,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { highlightJs } from "../js-highlight";
import { relativeTime } from "../../lib/relative-time";
import {
  agentFileContentUrl,
  agentFileDownloadUrl,
  agentFileResponse,
  createAgentThread,
  getAgentFileContent,
  listAgentFiles,
  listAgentThreads,
  sendAgentTurn,
  type AgentFileContent,
  type AgentFileEntry,
} from "./agents-api";
import {
  fileBreadcrumbs,
  formatFileSize,
  joinPath,
  parentPath,
  previewKindOf,
  type AgentsRoute,
} from "./agents-route";
import {
  EmptyState,
  ErrorState,
  InlineLoading,
  Mono,
  Section,
} from "./agent-ui";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.slice(0, 500);
}

interface CachedFileView {
  entries: AgentFileEntry[];
  listingDir: string;
  isDirectory: boolean;
  /** Present when a text/CSV file was prefetched with its parent listing. */
  preview?: AgentFileContent;
}

function fileViewKey(path: string, hidden: boolean): string {
  return `${hidden ? "1" : "0"}:${path}`;
}

function FileIcon({ entry }: { entry: AgentFileEntry }) {
  if (entry.kind === "dir") return <Folder className="size-4 text-muted-foreground" />;
  if (entry.symlink) return <Link2 className="size-4 text-muted-foreground" />;
  const kind = previewKindOf(entry.name);
  if (kind === "image") return <FileImage className="size-4 text-muted-foreground" />;
  if (kind === "text" || kind === "csv") return <FileText className="size-4 text-muted-foreground" />;
  return <File className="size-4 text-muted-foreground" />;
}

/** Blob URL for an inline image/PDF preview, revoked on change. */
function useBlobUrl(agentId: string, path: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let minted: string | null = null;
    void agentFileResponse(agentFileContentUrl(agentId, path))
      .then((res) => res.blob())
      .then((blob) => {
        if (!live) return;
        minted = URL.createObjectURL(blob);
        setUrl(minted);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
      if (minted) URL.revokeObjectURL(minted);
    };
  }, [agentId, path, enabled]);
  return url;
}

export function AgentFiles({
  agentId,
  filePath,
  onNavigate,
}: {
  agentId: string;
  filePath?: string;
  onNavigate: (route: AgentsRoute) => void;
}) {
  const [entries, setEntries] = useState<AgentFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [tick, setTick] = useState(0);
  const [preview, setPreview] = useState<AgentFileContent | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  /** The folder currently listed; for a file deep link this is its parent. */
  const [listingDir, setListingDir] = useState(filePath ?? "");
  const [isDirectory, setIsDirectory] = useState((filePath ?? "") === "");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const cache = useRef(new Map<string, CachedFileView>());
  const forceNextFetch = useRef(false);

  const path = filePath ?? "";
  const activeKey = fileViewKey(path, hidden);
  const cachedView = cache.current.get(activeKey);
  const shownEntries = cachedView?.entries ?? entries;
  const shownListingDir = cachedView?.listingDir ?? listingDir;
  const shownIsDirectory = cachedView?.isDirectory ?? isDirectory;
  const previewKind = previewKindOf(path.split("/").pop() ?? "");
  const inlinePreview = previewKind === "image" || previewKind === "pdf";
  const blobUrl = useBlobUrl(agentId, path, path !== "" && !shownIsDirectory && inlinePreview);
  const breadcrumbs = useMemo(() => fileBreadcrumbs(path), [path]);
  const normalize = (rows: AgentFileEntry[], dir: string): AgentFileEntry[] =>
    rows.map((entry) => ({
      ...entry,
      path: entry.path || joinPath(dir, entry.name),
    }));

  const remember = (key: string, view: CachedFileView) => {
    const map = cache.current;
    map.delete(key);
    map.set(key, view);
    while (map.size > 40) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  useEffect(() => {
    let live = true;
    if (forceNextFetch.current) {
      forceNextFetch.current = false;
    } else {
      const hit = cache.current.get(activeKey);
      if (hit) {
        setError(null);
        setEntries(hit.entries);
        setListingDir(hit.listingDir);
        setIsDirectory(hit.isDirectory);
        return () => {
          live = false;
        };
      }
    }
    setError(null);
    setEntries(null);
    void listAgentFiles(agentId, path, hidden)
      .then((rows) => {
        if (!live) return;
        setEntries(normalize(rows, path));
        setListingDir(path);
        setIsDirectory(true);
      })
      .catch(async (err: unknown) => {
        // A file deep link lists its parent; the file itself is the preview.
        if (path !== "") {
          try {
            const parent = parentPath(path);
            const rows = await listAgentFiles(agentId, parent, hidden);
            if (!live) return;
            setEntries(normalize(rows, parent));
            setListingDir(parent);
            setIsDirectory(false);
            return;
          } catch {
            // Fall through to the original error.
          }
        }
        if (!live) return;
        setError(err instanceof Error ? err.message : "Could not read this folder.");
      });
    return () => {
      live = false;
    };
  }, [agentId, path, hidden, tick, activeKey]);

  useEffect(() => {
    if (path === "" || shownIsDirectory || inlinePreview) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const cachedPreview = cache.current.get(activeKey)?.preview;
    if (cachedPreview !== undefined) {
      setPreview(cachedPreview);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let live = true;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    void getAgentFileContent(agentId, path)
      .then((content) => {
        if (live) setPreview(content);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPreviewError(err instanceof Error ? err.message : "Could not preview this file.");
      })
      .finally(() => {
        if (live) setPreviewLoading(false);
      });
    return () => {
      live = false;
    };
  }, [agentId, path, inlinePreview, shownIsDirectory, activeKey]);

  const refresh = () => {
    cache.current.delete(activeKey);
    forceNextFetch.current = true;
    setTick((t) => t + 1);
  };

  /** Load the target listing first, then change the URL. The old view stays
   *  on screen until the data is ready, so the route change never flashes a
   *  loading state. */
  const navigateToDir = async (target: string) => {
    if (target === path) return;
    setPendingPath(target === "" ? "/" : target);
    try {
      const rows = await listAgentFiles(agentId, target, hidden);
      remember(fileViewKey(target, hidden), {
        entries: normalize(rows, target),
        listingDir: target,
        isDirectory: true,
      });
    } catch {
      // Fall through: the destination can render its own error state.
    } finally {
      setPendingPath(null);
    }
    onNavigate({
      view: "agent",
      agentId,
      tab: "files",
      ...(target ? { filePath: target } : {}),
    });
  };

  const openEntry = async (entry: AgentFileEntry) => {
    if (entry.kind === "dir") {
      await navigateToDir(entry.path);
      return;
    }
    const parent = parentPath(entry.path);
    setPendingPath(entry.path);
    try {
      const kind = previewKindOf(entry.name);
      const [rows, preview] = await Promise.all([
        listAgentFiles(agentId, parent, hidden),
        kind === "image" || kind === "pdf"
          ? Promise.resolve(undefined)
          : getAgentFileContent(agentId, entry.path).catch(() => undefined),
      ]);
      remember(fileViewKey(entry.path, hidden), {
        entries: normalize(rows, parent),
        listingDir: parent,
        isDirectory: false,
        ...(preview === undefined ? {} : { preview }),
      });
    } catch {
      // The destination will surface the error.
    } finally {
      setPendingPath(null);
    }
    onNavigate({ view: "agent", agentId, tab: "files", filePath: entry.path });
  };

  const download = () => {
    const url = `${agentFileDownloadUrl(agentId, path)}`;
    void agentFileResponse(url).then((res) => res.blob()).then((blob) => {
      const a = document.createElement("a");
      const href = URL.createObjectURL(blob);
      a.href = href;
      a.download = path.split("/").pop() ?? "download";
      a.click();
      URL.revokeObjectURL(href);
    });
  };

  const editViaAgent = async () => {
    setEditBusy(true);
    try {
      const threads = await listAgentThreads(agentId);
      const thread = threads.find((t) => t.kind === "default") ?? threads[0]
        ?? (await createAgentThread(agentId, "Files"));
      await sendAgentTurn(agentId, {
        thread_id: thread.id,
        message: `Please edit the workspace file \`${path}\`. Read it first, then make the change I describe in the next message.`,
      });
      onNavigate({ view: "agent", agentId, tab: "threads", threadId: thread.id });
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Could not open a thread.");
      setEditBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:grid-rows-1">
      {/* listing column */}
      <div className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <nav aria-label="File path" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[12.5px]">
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.path || "root"} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
                <button
                  type="button"
                  onClick={() => void navigateToDir(crumb.path)}
                  className={`max-w-40 truncate rounded px-1 py-0.5 outline-none hover:bg-accent ${
                    i === breadcrumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setHidden((h) => !h)}
            title={hidden ? "Hide hidden files" : "Show hidden files"}
          >
            {hidden ? <EyeOff /> : <Eye />}
            {hidden ? "Hide hidden" : "Show hidden"}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
          {error !== null && (
            <div className="p-3">
              <ErrorState
                title="Could not read the workspace"
                message={error}
                onRetry={refresh}
              />
            </div>
          )}
          {error === null && shownEntries === null && (
            <div className="p-3">
              <InlineLoading label="Loading files" />
            </div>
          )}
          {error === null && shownEntries !== null && shownEntries.length === 0 && (
            <div className="p-3">
              <EmptyState
                icon={<Folder className="size-5" />}
                title="This folder is empty"
                body="The agent creates files here when it works."
              />
            </div>
          )}
          {error === null && shownEntries !== null && shownEntries.length > 0 && (
            <ul>
              {shownListingDir !== "" && (
                <li>
                  <button
                    type="button"
                    onClick={() => void navigateToDir(parentPath(listingDir))}
                    className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-accent/50"
                  >
                    <Folder className="size-4" />
                    ..
                  </button>
                </li>
              )}
              {shownEntries.map((entry) => {
                const selected = entry.path === path;
                return (
                  <li key={entry.path || entry.name}>
                    <button
                      type="button"
                      onClick={() => openEntry(entry)}
                      className={`flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left outline-none transition-colors hover:bg-accent/50 ${
                        selected ? "bg-accent" : ""
                      }`}
                    >
                      <FileIcon entry={entry} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
                      {entry.symlink && (
                        <span className="rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
                          symlink
                        </span>
                      )}
                      {pendingPath === entry.path ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <span className="hidden shrink-0 text-[11.5px] text-muted-foreground sm:block">
                          {entry.kind === "dir" ? "—" : formatFileSize(entry.size)}
                        </span>
                      )}
                      <span className="hidden w-20 shrink-0 text-right text-[11.5px] text-muted-foreground md:block">
                        {entry.mtime ? relativeTime(entry.mtime) : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* preview column */}
      <div className="flex min-h-0 flex-col">
        {path === "" || shownIsDirectory ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
            Select a file to preview it. The workspace is read-only in the browser.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{path.split("/").pop()}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{path}</p>
              </div>
              <Button variant="outline" size="sm" onClick={download}>
                <Download />
                Download
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={editBusy}
                onClick={() => void editViaAgent()}
                title="Open a thread and ask the agent to edit this file"
              >
                {editBusy ? <Loader2 className="animate-spin" /> : <Pencil />}
                Edit via agent
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3" data-scrollable>
              {previewError !== null && (
                <ErrorState
                  title="Could not preview this file"
                  message={previewError}
                  onRetry={refresh}
                />
              )}
              {previewError === null && previewLoading && <InlineLoading label="Loading preview" />}
              {previewError === null && !previewLoading && inlinePreview && (
                blobUrl === null ? (
                  <InlineLoading label="Loading preview" />
                ) : previewKind === "image" ? (
                  <img
                    src={blobUrl}
                    alt={path.split("/").pop() ?? "image"}
                    className="mx-auto max-h-[70vh] max-w-full rounded-lg border border-border object-contain"
                  />
                ) : (
                  <iframe
                    src={blobUrl}
                    title={path.split("/").pop() ?? "PDF preview"}
                    className="h-[70vh] w-full rounded-lg border border-border bg-background"
                  />
                )
              )}
              {previewError === null && !previewLoading && !inlinePreview && preview !== null && (
                <FilePreview content={preview} path={path} />
              )}
              {previewError === null && !previewLoading && !inlinePreview && preview === null && (
                <EmptyState
                  title="No preview"
                  body="Download the file to inspect it."
                  action={
                    <Button variant="outline" size="sm" onClick={download}>
                      <Download />
                      Download
                    </Button>
                  }
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FilePreview({ content, path }: { content: AgentFileContent; path: string }) {
  const kind = previewKindOf(path.split("/").pop() ?? "");
  const text = content.text ?? "";
  if (kind === "csv") {
    const rows = parseCsv(text);
    const header = rows[0] ?? [];
    return (
      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-border bg-secondary px-2 py-1.5 text-left font-medium"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((row, r) => (
              <tr key={r} className="border-b border-border last:border-b-0">
                {row.map((cell, c) => (
                  <td key={c} className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (kind === "text") {
    const language = (content.language ?? "").toLowerCase();
    const highlighted = ["js", "jsx", "ts", "tsx", "javascript", "typescript"].includes(language);
    return (
      <div className="space-y-2">
        <pre className="overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-[12px] leading-relaxed">
          <code>{highlighted ? highlightJs(text) : text}</code>
        </pre>
        {content.truncated && (
          <p className="text-[12px] text-muted-foreground">
            Preview cut at the server limit. Download the file for the full content.
          </p>
        )}
      </div>
    );
  }
  return (
    <Section title="Binary file" description="This file has no inline preview.">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <File className="size-4" />
        <Mono>{path}</Mono>
        <span>· {formatFileSize(content.size)}</span>
      </div>
    </Section>
  );
}

