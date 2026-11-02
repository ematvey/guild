// Tool call frames: the collapsed header (icon, label, request preview) and
// the expanded body per persisted widget kind.
import { useState } from "react";
import {
  Download,
  FileCode2,
  FileDiff,
  FileDown,
  FileText,
  Globe,
  Loader2,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import Markdown from "react-markdown";
import { Frame } from "../frame";
import { CHAT_MD_PLUGINS, MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import { highlightJs } from "../js-highlight";
import { openExternal } from "../../lib/open-external";
import { toolArtifactBlobUrl } from "../../lib/api/chats";
import {
  artifactCardOf,
  type ArtifactCard,
  type CodemodeCallRow,
  type ToolBlock,
} from "../../lib/thread-reducer";
import { formatBytes } from "../../lib/format";
import { argOf, codemodeDuration, parseSearchResults, safeUrl, toolKind, toolLabel, toolPreview } from "./tool-text";

/// Status pill on tool frames and page cards.
export function StatusPill({ status }: { status: "running" | "done" | "error" }) {
  const cls = {
    running: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
  }[status];
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-px text-xs uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

export function statusPillCls(ok: boolean): string {
  return ok
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : "border-destructive/40 bg-destructive/10 text-destructive";
}

export function TruncatedBadge() {
  return (
    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400">
      truncated
    </span>
  );
}

function ToolKindIcon({ kind }: { kind: string }) {
  const cls = "size-3 shrink-0 text-muted-foreground";
  switch (kind) {
    case "search":
      return <Search className={cls} />;
    case "fetch":
      return <Globe className={cls} />;
    case "terminal":
      return <SquareTerminal className={cls} />;
    case "codemode":
      return <FileCode2 className={cls} />;
    case "read":
      return <FileText className={cls} />;
    case "artifact":
      return <FileDown className={cls} />;
    case "diff":
      return <FileDiff className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

/// Download chip for a spilled tool_result, mirroring the user-attachment
/// chip family: type icon, filename, human size, download button. Bytes
/// fetch authed from /api/v1/tool_artifacts/{id} and save through the
/// browser/app download path. Failed fetches re-enable the button for a
/// retry.
function ArtifactDownloadCard({ card }: { card: ArtifactCard }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const download = async () => {
    setState("busy");
    try {
      const u = await toolArtifactBlobUrl(card.id);
      if (!u) throw new Error("artifact fetch failed");
      const a = document.createElement("a");
      a.href = u;
      a.download = card.filename;
      a.click();
      URL.revokeObjectURL(u);
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 py-1">
      <FileDown className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-56 truncate font-medium" title={card.filename}>
        {card.filename}
      </span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(card.size_bytes)}</span>
      {card.content_type !== "application/octet-stream" && (
        <span className="hidden shrink-0 text-muted-foreground/70 sm:inline">{card.content_type}</span>
      )}
      {card.path && (
        <span
          className="hidden w-full truncate font-mono text-xs text-muted-foreground/60 sm:block"
          title={card.path}
        >
          {card.path}
        </span>
      )}
      <button
        type="button"
        title={state === "failed" ? "Download failed — retry" : "Download"}
        className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
        disabled={state === "busy"}
        onClick={() => void download()}
      >
        {state === "busy" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Download className="size-3" />
        )}
        {state === "failed" ? "Retry" : "Download"}
      </button>
    </div>
  );
}

/// The codemode script's nested tool calls (pi-durable result details),
/// one compact row per call: `toolname(args) → status`. Same pill palette
/// as the tool frames; a failed call's error text rides under the row.
function CodemodeCallList({ calls }: { calls: CodemodeCallRow[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {calls.map((c) => {
        const cls =
          c.status === "ok"
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : c.status === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border bg-muted text-muted-foreground";
        return (
          <div
            key={c.id}
            className={`border-b border-border/60 px-2.5 py-1.5 last:border-b-0 ${c.status === "error" ? "bg-destructive/5" : ""}`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-muted-foreground" title={c.args}>
                {c.name}
                <span className="text-muted-foreground/60">(</span>
                {c.args ?? ""}
                <span className="text-muted-foreground/60">)</span>
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {c.durationMs != null && (
                  <span className="text-xs tabular-nums text-muted-foreground/60">
                    {codemodeDuration(c.durationMs)}
                  </span>
                )}
                <span className={`rounded-full border px-1.5 py-px text-xs uppercase tracking-wide ${cls}`}>
                  {c.status}
                </span>
              </span>
            </div>
            {c.error && (
              <div className="mt-1 whitespace-pre-wrap break-all text-xs leading-relaxed text-destructive/90">
                {c.error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/// Per-widget body of an expanded tool frame, driven by the persisted `meta`
/// on the tool_result event (spec C.2 → C.3). Tools without meta fall back
/// to pretty JSON of the arguments plus the raw content.
function ToolBody({ t }: { t: ToolBlock }) {
  const m = t.meta;
  const kind = toolKind(t);
  if (kind === "codemode") {
    // The script source rides the arguments ({ code, options? } — a
    // grammar-sampled call may carry the source as the raw string).
    let code = "";
    try {
      const a: unknown = JSON.parse(t.args);
      code = typeof a === "string" ? a : typeof (a as { code?: unknown })?.code === "string" ? ((a as { code: string }).code) : "";
    } catch {
      code = t.args ?? "";
    }
    return (
      <div className="space-y-2">
        <CodemodeCallList calls={m?.calls ?? []} />
        {code && (
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed">
            {highlightJs(code)}
          </pre>
        )}
        {t.content && (
          <pre
            className={`max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed ${
              t.status === "error" ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {t.content}
          </pre>
        )}
        {t.status === "running" && (
          <span className="animate-pulse text-muted-foreground">running…</span>
        )}
      </div>
    );
  }
  if (kind === "artifact") {
    const card = artifactCardOf(t);
    // The card replaces the raw content — the model-facing pointer text
    // (path + head excerpt) is not useful to show verbatim.
    if (card) return <ArtifactDownloadCard card={card} />;
  }
  if (kind === "search") {
    const sources = m?.sources?.length
      ? m.sources
      : parseSearchResults(t.content ?? "");
    return (
      <div className="space-y-2">
        {sources.map((s, i) => {
          const href = safeUrl(s.url);
          return (
            <div key={i}>
              {href ? (
                <a
                  href={href}
                  className="break-all font-medium underline decoration-border underline-offset-2 hover:decoration-foreground"
                  onClick={e => {
                    e.preventDefault();
                    openExternal(href);
                  }}
                >
                  {s.title || s.url}
                </a>
              ) : (
                <span className="break-all font-medium">{s.title || s.url}</span>
              )}
              {s.snippet && <p className="mt-0.5 text-muted-foreground">{s.snippet}</p>}
            </div>
          );
        })}
        {t.status === "running" && (
          <span className="animate-pulse text-muted-foreground">running…</span>
        )}
        {sources.length === 0 && t.content && (
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs text-muted-foreground">
            {t.content}
          </pre>
        )}
      </div>
    );
  }
  if (kind === "fetch") {
    const url = m?.url || argOf(t, ["url"]) || "";
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(() => {
            const href = safeUrl(url);
            return href ? (
              <a
                href={href}
                className="min-w-0 flex-1 truncate underline decoration-border underline-offset-2 hover:decoration-foreground"
                title={url}
                onClick={e => {
                  e.preventDefault();
                  openExternal(href);
                }}
              >
                {url}
              </a>
            ) : url ? (
              <span className="min-w-0 flex-1 truncate" title={url}>
                {url}
              </span>
            ) : null;
          })()}
          {/* pills only for failures: HTTP errors surface, 2xx stays quiet */}
          {m?.status_code != null && m.status_code >= 400 && (
            <span
              className={`shrink-0 rounded-full border px-1.5 py-px text-xs uppercase tracking-wide ${statusPillCls(false)}`}
            >
              {m.status_code}
            </span>
          )}
          {m?.truncated && <TruncatedBadge />}
        </div>
        {m?.title && <p className="font-medium">{m.title}</p>}
        {t.content && (
          <div className={`max-h-64 overflow-y-auto ${MD_CLASS} ${MD_TABLE_CLASS}`}>
            <Markdown remarkPlugins={CHAT_MD_PLUGINS} components={mdComponents}>{t.content}</Markdown>
          </div>
        )}
        {t.status === "running" && (
          <span className="animate-pulse text-muted-foreground">running…</span>
        )}
      </div>
    );
  }
  if (kind === "terminal") {
    const command = argOf(t, ["command", "cmd", "script"]);
    const output = m?.output ?? t.content ?? "";
    return (
      <div className="space-y-2">
        {command && (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed">
            <span className="select-none text-muted-foreground/60">$ </span>
            {command}
          </pre>
        )}
        {output && (
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            {output}
          </pre>
        )}
        {/* failures only: a clean exit stays quiet */}
        {m?.exit_code != null && m.exit_code !== 0 && (
          <span
            className={`inline-block rounded-full border px-1.5 py-px text-xs uppercase tracking-wide ${statusPillCls(false)}`}
          >
            exit {m.exit_code}
          </span>
        )}
      </div>
    );
  }
  if (kind === "read") {
    const lines = (t.content ?? "").split("\n");
    const start = m?.offset ?? 1;
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span className="min-w-0 truncate font-mono" title={m?.path}>
            {m?.path}
          </span>
          {m?.total_lines != null && (
            <span className="shrink-0 text-xs">
              {lines.length}/{m.total_lines} lines
            </span>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">
                {start + i}
              </span>
              <span className="whitespace-pre-wrap break-all">{l}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "diff") {
    return (
      <div className="space-y-2">
        {m?.path && (
          <span className="block min-w-0 truncate font-mono text-muted-foreground" title={m.path}>
            {m.path}
          </span>
        )}
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
          {(t.content ?? "").split("\n").map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith("+") && !l.startsWith("+++")
                  ? "text-emerald-600 dark:text-emerald-400"
                  : l.startsWith("-") && !l.startsWith("---")
                    ? "text-destructive"
                    : l.startsWith("@@")
                      ? "text-muted-foreground"
                      : undefined
              }
            >
              {l}
            </div>
          ))}
        </pre>
      </div>
    );
  }
  let prettyArgs = t.args;
  try {
    prettyArgs = JSON.stringify(JSON.parse(t.args), null, 2);
  } catch {
    /* keep the raw arguments string */
  }
  return (
    <div className="space-y-2">
      {prettyArgs && prettyArgs !== "{}" && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          {prettyArgs}
        </pre>
      )}
      {t.content && (
        <pre
          className={`max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed ${
            t.status === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {t.content}
        </pre>
      )}
      {t.status === "running" && (
        <span className="animate-pulse text-muted-foreground">running…</span>
      )}
    </div>
  );
}

/// One collapsible frame per tool_call block: header is kind icon + tool
/// name + request preview (search → query, fetch → URL, …). The preview
/// stays on the header line whether the frame is collapsed or expanded; a
/// running call pulses until its result lands.
export function ToolFrame({ t }: { t: ToolBlock }) {
  const preview = toolPreview(t);
  const running = t.status === "running";
  const pulse = running ? "animate-pulse" : "";
  return (
    <Frame
      icon={<ToolKindIcon kind={toolKind(t)} />}
      title={
        <>
          <span className={`mr-3 font-medium text-foreground/80 ${pulse}`}>
            {toolLabel(t)}
          </span>
          {preview && (
            <span
              className={`hidden max-w-72 truncate text-muted-foreground sm:inline ${pulse}`}
              title={preview}
            >
              {preview}
            </span>
          )}
        </>
      }
      badge={
        // Pills only signal trouble: DONE is implicit, ERROR stays visible.
        t.status === "error" ? <StatusPill status={t.status} /> : undefined
      }
    >
      <ToolBody t={t} />
    </Frame>
  );
}
