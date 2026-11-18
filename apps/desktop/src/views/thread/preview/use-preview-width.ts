// The preview pane's width and its drag, kept in the one place the pane reads
// them. The divider sits on the pane's left edge, so the delta is inverted:
// dragging left widens the pane, dragging right narrows it.
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { trackDrag } from "../../../lib/drag";
import {
  clampPreviewWidth,
  PREVIEW_DEFAULT_W,
  PREVIEW_WIDTH_EVENT,
  savePreviewWidth,
  storedPreviewWidth,
} from "../../../lib/preview";

export function usePreviewWidth() {
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
      const startW = width;
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
    [width],
  );

  const resetWidth = useCallback(() => {
    setWidth(PREVIEW_DEFAULT_W);
    savePreviewWidth(PREVIEW_DEFAULT_W);
  }, []);

  return { width, resizing, startDrag, resetWidth };
}
