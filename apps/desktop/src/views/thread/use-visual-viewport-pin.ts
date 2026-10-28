// The keyboard shrinks the visual viewport and pans the document; a fixed
// shell is anchored to the layout viewport, so it has to take both the
// visible height and the pan. The writes are synchronous with the viewport
// event: deferred to a frame callback they land one frame behind the
// compositor's pan.
//
// No page API runs in the same frame as that pan, so the header cannot be
// held perfectly still while it happens. It is hidden for the length of the
// transition instead — by the time it is back, the geometry is correct.
import { useEffect, type RefObject } from "react";

export function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    let lastTop = -1;
    let lastHeight = -1;
    let settle = 0;
    const apply = () => {
      const top = Math.round(Math.max(vv.offsetTop, window.scrollY));
      const height = Math.round(vv.height);
      if (top === lastTop && height === lastHeight) return;
      lastTop = top;
      lastHeight = height;
      el.style.top = top ? `${top}px` : "";
      el.style.height = `${height}px`;
      el.dataset.vpMoving = "1";
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        delete el.dataset.vpMoving;
      }, 180);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      window.clearTimeout(settle);
      delete el.dataset.vpMoving;
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      el.style.top = "";
      el.style.height = "";
    };
  }, [ref]);
}
