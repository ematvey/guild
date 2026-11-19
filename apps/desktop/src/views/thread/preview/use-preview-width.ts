// The preview pane's width and its drag, kept in the one place the pane reads
// them. The divider sits on the pane's left edge, so the delta is inverted:
// dragging left widens the pane, dragging right narrows it.
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { trackDrag } from "../../../lib/drag";
import {
  clampPreviewWidth,
  PREVIEW_DEFAULT_W,
  PREVIEW_WIDTH_EVENT,
  savePreviewWidth,
  storedPreviewWidth,
} from "../../../lib/preview";

/** The pane's width. `pane` is the rendered aside: the cap can make it
 *  narrower than the stored value, so a drag starts from what the reader
 *  actually sees, not from the number in storage. */
export function usePreviewWidth(pane: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number>(storedPreviewWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const resync = () => setWidth(storedPreviewWidth());
    window.addEventListener(PREVIEW_WIDTH_EVENT, resync);
    return () => window.removeEventListener(PREVIEW_WIDTH_EVENT, resync);
  }, []);

  const startDrag = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = pane.current?.getBoundingClientRect().width ?? width;
      setResizing(true);
      trackDrag(
        (x) => setWidth(clampPreviewWidth(startW + startX - x)),
        () => {
          setResizing(false);
          setWidth((w) => {
            savePreviewWidth(w);
            return w;
          });
        },
      );
    },
    [pane, width],
  );

  const resetWidth = useCallback(() => {
    setWidth(PREVIEW_DEFAULT_W);
    savePreviewWidth(PREVIEW_DEFAULT_W);
  }, []);

  return { width, resizing, startDrag, resetWidth };
}
