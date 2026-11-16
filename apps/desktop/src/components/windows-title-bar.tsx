// The Windows caption buttons and the resize edges of the undecorated window
// (tauri.windows.conf.json sets decorations false). Nothing is painted: the
// columns run to the window edge with their own backgrounds, and the three
// buttons occupy the right end of the first row, which each page header pads
// for (CAPTION_BUTTONS_INSET). The edges restore what a native frame gives for
// free — dragging any side or corner to resize.

import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TOP_ROW, titleBarDrag } from "../lib/titlebar";

/** The edge or corner a resize drag starts from (the shape the window API
 *  takes; the package keeps it private). */
type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const BUTTON =
  "flex h-8 w-[46px] items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground";
/** One resize edge: a thin strip that hands the drag to the window. */
function Edge({ direction, className }: { direction: ResizeDirection; className: string }) {
  return (
    <div
      aria-hidden="true"
      className={`absolute z-[70] ${className}`}
      onMouseDown={(e) => {
        e.preventDefault();
        void getCurrentWindow().startResizeDragging(direction);
      }}
    />
  );
}

export function WindowsTitleBar() {
  const [maximized, setMaximized] = useState(false);

  // The middle button shows restore while the window is maximized, and the
  // window tells us when that changes (a snap, a double click, a hotkey).
  useEffect(() => {
    const win = getCurrentWindow();
    let live = true;
    const sync = () => {
      void win
        .isMaximized()
        .then((v) => live && setMaximized(v))
        .catch(() => {});
    };
    sync();
    const un = win.onResized(sync);
    return () => {
      live = false;
      void un.then((off) => off());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <>
      {/* The right end of the first row: the page header under it reserves
          exactly this box, so the buttons sit on the same line as the row's
          own title and controls. */}
      <div {...titleBarDrag} className={`absolute right-0 top-0 z-[60] flex ${TOP_ROW} items-center`}>
        <button aria-label="Minimize" className={BUTTON} onClick={() => void win.minimize()}>
          <Minus className="size-3.5" />
        </button>
        <button
          aria-label={maximized ? "Restore" : "Maximize"}
          className={BUTTON}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
        </button>
        <button
          aria-label="Close"
          className={`${BUTTON} hover:bg-[#c42b1c] hover:text-white`}
          onClick={() => void win.close()}
        >
          <X className="size-4" />
        </button>
      </div>
      {/* A maximized window has no edges to drag. */}
      {!maximized && (
        <>
          <Edge direction="North" className="inset-x-2 top-0 h-1 cursor-ns-resize" />
          <Edge direction="South" className="inset-x-2 bottom-0 h-1 cursor-ns-resize" />
          <Edge direction="West" className="inset-y-2 left-0 w-1 cursor-ew-resize" />
          <Edge direction="East" className="inset-y-2 right-0 w-1 cursor-ew-resize" />
          <Edge direction="NorthWest" className="left-0 top-0 size-2 cursor-nwse-resize" />
          <Edge direction="NorthEast" className="right-0 top-0 size-2 cursor-nesw-resize" />
          <Edge direction="SouthWest" className="bottom-0 left-0 size-2 cursor-nesw-resize" />
          <Edge direction="SouthEast" className="bottom-0 right-0 size-2 cursor-nwse-resize" />
        </>
      )}
    </>
  );
}
