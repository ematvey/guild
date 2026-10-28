// iOS Safari does not shrink the layout viewport when the keyboard opens —
// it overlays it and pans the page to reveal the focused input, dragging
// the fixed app shell (header included) off-screen. Pin the shell to the
// visual viewport for as long as one exists: same top offset, same visible
// height, tracked on every resize and scroll. With no keyboard the two
// viewports agree, so the pin is a no-op and there is no threshold to cross
// mid-animation — a threshold is what makes the header jump when it flips.
import { useEffect, type RefObject } from "react";

export function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      // The document cannot scroll, so the pan is always zero and only the
      // height moves. A top offset is still honoured for the browsers that
      // pan the visual viewport without a document scroll.
      const top = Math.round(vv.offsetTop);
      el.style.top = top ? `${top}px` : "";
      el.style.height = `${Math.round(vv.height)}px`;
    };
    // The viewport fires many times during the keyboard animation; one write
    // per frame keeps the shell from thrashing between two offsets.
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
      el.style.top = "";
      el.style.height = "";
    };
  }, [ref]);
}
