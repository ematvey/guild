// The thread view's two drag-resizable widths: the sidebar panel and the
// centered conversation column. Each persists its width and follows a
// resize made by another surface (the settings pane) through its event.
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { clampSidebarWidth, saveSidebarWidth, storedSidebarWidth } from "../../../lib/sidebar-width";
import { CHAT_DEFAULT_W, clampChatWidth, saveChatWidth, storedChatWidth } from "../../../lib/chat-width";

/** Follows the pointer from mousedown to mouseup; the end commits once. */
function trackDrag(move: (clientX: number) => void, end: () => void): void {
  const onMove = (ev: MouseEvent) => move(ev.clientX);
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    end();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** The desktop sidebar panel's width. While dragging, `resizing` lets the
 *  view suspend its width transition — an animated width chases the cursor
 *  and reads as lag. */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number>(() => storedSidebarWidth());
  const [resizing, setResizing] = useState(false);
  // Settings may resize the shared width while this sidebar stays mounted.
  useEffect(() => {
    const resync = () => setWidth(storedSidebarWidth());
    window.addEventListener("guild:sidebar-width-changed", resync);
    return () => window.removeEventListener("guild:sidebar-width-changed", resync);
  }, []);
  const startDrag = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    trackDrag(
      (x) => setWidth(clampSidebarWidth(startW + x - startX)),
      () => {
        setResizing(false);
        setWidth((w) => {
          saveSidebarWidth(w);
          return w;
        });
      },
    );
  }, [width]);
  return { width, resizing, startDrag };
}

/** The conversation column's width, with one drag handle per edge. The
 *  column is centered, so one pixel of cursor travel moves both edges — the
 *  width follows the doubled delta, outward for the handle being dragged.
 *  Dragging stops at the pane edge, not at the stored maximum, so a handle
 *  never runs away. */
export function useChatColumnWidth(pane: RefObject<HTMLDivElement | null>) {
  const [chatWidth, setChatWidth] = useState<number>(() => storedChatWidth());
  const [chatResizing, setChatResizing] = useState(false);
  useEffect(() => {
    const resync = () => setChatWidth(storedChatWidth());
    window.addEventListener("guild:chat-width-changed", resync);
    return () => window.removeEventListener("guild:chat-width-changed", resync);
  }, []);
  const startChatDrag = useCallback((e: ReactMouseEvent, side: "left" | "right") => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth;
    const paneW = pane.current?.clientWidth ?? window.innerWidth;
    const dir = side === "right" ? 1 : -1;
    setChatResizing(true);
    trackDrag(
      (x) => setChatWidth(clampChatWidth(Math.min(startW + (x - startX) * 2 * dir, paneW))),
      () => {
        setChatResizing(false);
        setChatWidth((w) => {
          saveChatWidth(w);
          return w;
        });
      },
    );
  }, [chatWidth, pane]);
  const resetChatWidth = useCallback(() => {
    setChatWidth(CHAT_DEFAULT_W);
    saveChatWidth(CHAT_DEFAULT_W);
  }, []);
  // Keyboard nudge: the key that moves a handle outward grows the column.
  const nudgeChatWidth = useCallback((key: string, side: "left" | "right") => {
    const outward = side === "right" ? key === "ArrowRight" : key === "ArrowLeft";
    setChatWidth((w) => {
      const next = clampChatWidth(w + (outward ? 64 : -64));
      saveChatWidth(next);
      return next;
    });
  }, []);
  return { chatWidth, chatResizing, startChatDrag, resetChatWidth, nudgeChatWidth };
}
