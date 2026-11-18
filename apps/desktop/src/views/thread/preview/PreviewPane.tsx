// The thread's preview pane: the chat on the left, the open file on the
// right, with one tab per file the reader opened. It renders HTML in a
// sandboxed frame (a hostile page gets an opaque origin, not this app's),
// PDFs in a frame, images as images, and text as text; anything else offers
// the download. On a narrow screen the pane is a full-window overlay.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FileText, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { openExternal } from "../../../lib/open-external";
import { HAS_SHELL } from "../../../lib/session";
import { CAPTION_BUTTONS_INSET, TITLE_BAR_INSET, TOP_ROW, titleBarDrag, titleBarDragDeep } from "../../../lib/titlebar";
import type { PreviewRef } from "../route";
import { usePreviewWidth } from "./use-preview-width";
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
  // Text and HTML are read into the pane rather than pointed at a URL: a
  // sandboxed frame has an opaque origin, and Chrome refuses to load a
  // `blob:` URL minted by this document into such a frame (it renders blank).
  // `srcdoc` carries the bytes instead, and the sandbox still holds.
  const [text, setText] = useState<string | null>(null);
  const readsText = view === "text" || view === "html";

  useEffect(() => {
    if (!readsText || source === null || source.url === null) {
      setText(null);
      return;
    }
    let dead = false;
    void fetch(source.url)
      .then((res) => res.text())
      .then((body) => {
        if (!dead) setText(body.slice(0, 2_000_000));
      })
      .catch(() => {
        if (!dead) setText(null);
      });
    return () => {
      dead = true;
    };
  }, [readsText, source?.url]);

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
    // The desktop shell is WebKitGTK, which has no PDF viewer: a frame there
    // is a blank page. The browser build renders it, so the shell gets the
    // download and the browser instead.
    if (HAS_SHELL) {
      return (
        <PaneNote text="The desktop app cannot show PDFs in place. Use Download, or open it in a browser." />
      );
    }
    const src = source.link ?? source.url;
    return src === null ? (
      <PaneNote text="Opening…" />
    ) : (
      <iframe src={src} title={source.filename} className="h-full w-full border-0 bg-white" />
    );
  }
  if (view === "html") {
    // The signed URL is the good path: the server serves it under a `sandbox`
    // policy, so the page keeps its own inline styles and scripts while the
    // frame still runs with an opaque origin. `srcdoc` is the fallback — it
    // inherits this app's policy, so an inline script inside the page is
    // dropped there.
    if (source.link !== null) {
      return <iframe src={source.link} title={source.filename} className="h-full w-full border-0 bg-white" />;
    }
    return text === null ? (
      <PaneNote text="Opening…" />
    ) : (
      <iframe
        srcDoc={text}
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
  const pane = useRef<HTMLElement | null>(null);
  const { width, resizing, startDrag, resetWidth } = usePreviewWidth(pane);
  // The address can name a file this session never opened — a deep link, a
  // reload, a link from a teammate. The pane shows it as a tab of its own
  // rather than rendering nothing.
  const shown =
    active !== null && !tabs.some((t) => sameRef(t.ref, active)) ? [...tabs, { ref: active }] : tabs;
  const tab = shown.find((t) => sameRef(t.ref, active)) ?? shown[0];
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
      {/* The pane's first row is the window's first row: it drags the window
          and stops short of the caption buttons. The pane's own controls sit
          in one bordered group, away from the caption box, so its close
          cannot be read as the window's. */}
      <div
        {...titleBarDragDeep}
        className={`flex ${TOP_ROW} shrink-0 items-center gap-2 border-b border-border px-3 ${CAPTION_BUTTONS_INSET}`}
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={source?.filename}>
          {source?.filename ?? "Preview"}
        </span>
        <div
          role="group"
          aria-label="Preview controls"
          className="mr-2 flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-secondary/40 p-0.5"
        >
          <Button variant="ghost" size="sm" className="size-9 px-0" onClick={download} title="Download">
            <Download className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-9 px-0"
            title="Open in a new window"
            onClick={() => source?.url !== null && source !== null && openExternal(source.url)}
          >
            <ExternalLink className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-9 px-0"
            title={full ? "Leave full screen" : "Full screen"}
            onClick={onToggleFull}
          >
            {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          <Button variant="ghost" size="sm" className="size-9 px-0" title="Close preview" onClick={onCloseAll}>
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {shown.length > 1 && <PreviewTabs tabs={shown} active={tab.ref} onSelect={onSelect} onClose={onClose} />}
      <div className="min-h-0 flex-1">
        <PreviewBody tab={tab} />
      </div>
    </div>
  );

  if (full) {
    return (
      <div {...titleBarDrag} className={`fixed inset-0 z-50 bg-background ${TITLE_BAR_INSET}`}>
        {body}
      </div>
    );
  }
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        {body}
      </div>
    );
  }
  // The pane's width is its own: the drag handle on the left edge sets it, and
  // the chat column keeps the width it has. The 22rem minimum is what the
  // header needs for the icon and the four size-9 controls beside the 138 px
  // caption box; the cap stops the pane at 900 px or at the row less 28rem,
  // so the chat column never falls below that on a wide window.
  return (
    <aside
      ref={pane}
      className={`relative flex h-full shrink-0 flex-col border-l border-border max-w-[min(900px,calc(100%-28rem))] md:min-w-[22rem] ${
        resizing ? "" : "transition-[width] duration-150"
      }`}
      style={{ width }}
    >
      {body}
      {/* The strip starts below the header row, at TOP_ROW's height, so the
          header keeps its whole drag region and only this 4 px edge resizes
          the pane. */}
      <div
        className="absolute bottom-0 left-0 top-11 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ring"
        title="Drag to resize · double-click to reset"
        onMouseDown={startDrag}
        onDoubleClick={resetWidth}
      />
    </aside>
  );
}
