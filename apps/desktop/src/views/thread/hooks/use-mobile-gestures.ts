// Touch handling for the app shell on a phone: the edge swipe that opens the
// drawer, the pan guard that keeps the fixed shell still, and the keyboard
// pin that keeps the composer above the on-screen keyboard.
import { useEffect, type RefObject } from "react";
import { useVisualViewportPin } from "../use-visual-viewport-pin";

export function useMobileGestures(input: {
  isMobile: boolean;
  /** The app shell root. */
  shell: RefObject<HTMLDivElement | null>;
  /** A rightward swipe from near the left edge. */
  onEdgeSwipe: () => void;
}) {
  const { isMobile, shell, onEdgeSwipe } = input;
  // A drag from the left opens the drawer. iOS owns the first ~20px of that
  // edge with its own back gesture, and a page cannot cancel it — so the drag
  // must start past that band. The system keeps the edge; the drawer takes
  // the rest; one swipe never does both.
  useEffect(() => {
    if (!isMobile) return;
    let startX = 0;
    let startY = 0;
    let armed = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      armed = t.clientX > 24 && t.clientX <= 96;
      startX = t.clientX;
      startY = t.clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (!armed) return;
      armed = false;
      const t = e.changedTouches[0];
      if (t.clientX - startX > 60 && Math.abs(t.clientY - startY) < 40) onEdgeSwipe();
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [isMobile, onEdgeSwipe]);

  // The shell is pinned to the visual viewport while the on-screen keyboard
  // is up (see useVisualViewportPin) so the header stays visible.
  useVisualViewportPin(shell);

  // Only surfaces marked `data-scrollable` scroll by touch. Anywhere else a
  // drag must not pan the page over the fixed shell — iOS Safari pans the
  // visual viewport even under a `position: fixed` root (header, composer
  // and banners would all move with the content). A scroller already at its
  // edge in the drag direction is blocked too: WebKit turns that surplus
  // drag into pull-to-refresh / rubber-band, which pans the whole shell.
  useEffect(() => {
    const el = shell.current;
    if (!el) return;
    let startY: number | null = null;
    const touchStart = (e: TouchEvent) => { startY = e.touches[0]?.clientY ?? null; };
    const block = (e: TouchEvent) => {
      const target = e.target as Element | null;
      const scroller = target?.closest?.("[data-scrollable]") as HTMLElement | null;
      if (!scroller) { e.preventDefault(); return; }
      const dy = startY === null ? 0 : (e.touches[0]?.clientY ?? 0) - startY;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((dy > 0 && atTop) || (dy < 0 && atBottom)) e.preventDefault();
    };
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", block, { passive: false });
    return () => {
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", block);
    };
  }, [shell]);
}
