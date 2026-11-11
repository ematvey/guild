// The thread view's drag-resizable conversation column. The sidebar column
// has its own shared state in views/sidebar/sidebar.tsx.
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { trackDrag } from "../../../lib/drag";
import { CHAT_DEFAULT_W, clampChatWidth, saveChatWidth, storedChatWidth } from "../../../lib/chat-width";

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
  const startChatDrag = useCallback(
    (e: ReactMouseEvent, side: "left" | "right") => {
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
    },
    [chatWidth, pane],
  );
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
