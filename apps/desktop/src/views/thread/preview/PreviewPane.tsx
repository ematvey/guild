// The thread's preview pane: the chat on the left, the open file on the
// right, with one tab per file the reader opened. It renders HTML in a
// sandboxed frame (a hostile page gets an opaque origin, not this app's),
// PDFs in a frame, images as images, and text as text; anything else offers
// the download. On a narrow screen the pane is a full-window overlay.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileText, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { openExternal } from "../../../lib/open-external";
import type { PreviewRef } from "../route";
import { previewViewOf, usePreviewSource, type PreviewMeta } from "./use-preview-source";

export interface PreviewTab {
  ref: PreviewRef;
  meta?: PreviewMeta;
}

export interface PreviewPaneProps {
  tabs: PreviewTab[];
  active: PreviewRef | null;
  full: boolean;
  isMobile: boolean;
  onSelect: (ref: PreviewRef) => void;
  onClose: (ref: PreviewRef) => void;
  onCloseAll: () => void;
  onToggleFull: () => void;
}

const sameRef = (a: PreviewRef | null, b: PreviewRef | null): boolean =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id;

/** One file, rendered by kind. */
function PreviewBody({ tab }: { tab: PreviewTab }) {
  const source = usePreviewSource(tab.ref, tab.meta);
  const view = useMemo(
    () => previewViewOf(source?.contentType ?? "", source?.filename ?? ""),
    [source?.contentType, source?.filename],
  );
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (view !== "text" || source?.url === null || source === null || source.url === null) {
      setText(null);
      return;
    }
    let dead = false;
    void fetch(source.url)
      .then((res) => res.text())
      .then((body) => {
        if (!dead) setText(body.slice(0, 400_000));
      })
      .catch(() => {
        if (!dead) setText(null);
      });
    return () => {
      dead = true;
    };
  }, [view, source?.url]);

  if (source === null) return <PaneNote text="Opening…" />;
  if (source.failed) return <PaneNote text="The file could not be read." />;
  if (source.url === null) return <PaneNote text="Opening…" />;

  if (view === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-secondary/40 p-4">
        <img src={source.url} alt={source.filename} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (view === "pdf") {
    return <iframe src={source.url} title={source.filename} className="h-full w-full border-0 bg-white" />;
  }
  if (view === "html") {
    // No allow-same-origin: the page runs with an opaque origin, so it cannot
    // read this app's storage, cookies or DOM.
    return (
      <iframe
        src={source.url}
        title={source.filename}
        sandbox="allow-scripts allow-popups allow-forms"
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  if (view === "text") {
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 text-sm text-foreground">
        {text ?? "Opening…"}
      </pre>
    );
  }
  return <PaneNote text="This file type has no preview. Use Download." />;
}

function PaneNote({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{text}</div>;
}

/** The tab strip: one entry per open file, the active one raised. */
function PreviewTabs({
  tabs,
  active,
  onSelect,
  onClose,
}: Pick<PreviewPaneProps, "tabs" | "active" | "onSelect" | "onClose">) {
  return (
    <div className="flex min-w-0 items-stretch gap-1 overflow-x-auto px-2 pt-2">
      {tabs.map((tab) => {
        const isActive = sameRef(active, tab.ref);
        return (
          <div
            key={`${tab.ref.kind}:${tab.ref.id}`}
            className={`group flex max-w-56 shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-xs ${
              isActive
                ? "border-border bg-background text-foreground"
                : "border-transparent bg-secondary/50 text-muted-foreground hover:bg-secondary"
            }`}
          >
            <button type="button" className="min-w-0 flex-1 truncate text-left" title={tab.meta?.filename} onClick={() => onSelect(tab.ref)}>
              {tab.meta?.filename ?? "Preview"}
            </button>
            <button
              type="button"
              title="Close"
              className="shrink-0 rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100"
              onClick={() => onClose(tab.ref)}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function PreviewPane(props: PreviewPaneProps) {
  const { tabs, active, full, isMobile, onSelect, onClose, onCloseAll, onToggleFull } = props;
  const tab = tabs.find((t) => sameRef(t.ref, active)) ?? tabs[0];
  const source = usePreviewSource(tab?.ref ?? null, tab?.meta);
  const download = useCallback(() => {
    if (source === null || source.url === null) return;
    const a = document.createElement("a");
    a.href = source.url;
    a.download = source.filename;
    a.click();
  }, [source]);

  // Escape leaves full screen; a second Escape closes the pane.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (full) onToggleFull();
      else if (isMobile) onCloseAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, isMobile, onToggleFull, onCloseAll]);

  if (tab === undefined) return null;

  const body = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={source?.filename}>
          {source?.filename ?? "Preview"}
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={download} title="Download">
          <Download className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2"
          title="Open in a new window"
          onClick={() => source?.url !== null && source !== null && openExternal(source.url)}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          title={full ? "Leave full screen" : "Full screen"}
          onClick={onToggleFull}
        >
          {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2" title="Close preview" onClick={onCloseAll}>
          <X className="size-3.5" />
        </Button>
      </div>
      {tabs.length > 1 && <PreviewTabs tabs={tabs} active={tab.ref} onSelect={onSelect} onClose={onClose} />}
      <div className="min-h-0 flex-1">
        <PreviewBody tab={tab} />
      </div>
    </div>
  );

  if (full) {
    return <div className="fixed inset-0 z-50 bg-background">{body}</div>;
  }
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        {body}
      </div>
    );
  }
  return <aside className="flex h-full w-[46%] min-w-[360px] max-w-[900px] shrink-0 flex-col border-l border-border">{body}</aside>;
}
