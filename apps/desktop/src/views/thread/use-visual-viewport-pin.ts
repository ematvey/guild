// The keyboard does not shrink the layout viewport; it shrinks the visual
// viewport, and iOS pans the document to reveal the focused input. A fixed
// shell is anchored to the visual viewport (measured: with scrollY 386 the
// header's rect top is still 0), so the pan needs no correction — but the
// shell still has to take the visible height, or the composer sits under the
// keyboard. Only the height is written. Writing `top` from offsetTop made
// the shell jump between screen 0 and screen offsetTop, because the two
// events disagree about the pan.
import { useEffect, type RefObject } from "react";

export function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      // A fixed shell is anchored to the layout viewport, so a document pan
      // has to be cancelled here or the header leaves the screen.
      const top = Math.round(Math.max(vv.offsetTop, window.scrollY));
      el.style.top = top ? `${top}px` : "";
      el.style.height = `${Math.round(vv.height)}px`;
    };
    // The viewport fires many times during the keyboard animation; one write
    // per frame keeps the shell from thrashing between two heights.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", schedule);
      el.style.height = "";
    };
  }, [ref]);
}
