// The keyboard shrinks the visual viewport and pans the document; a fixed
// shell is anchored to the layout viewport, so it has to take both the
// visible height and the pan. The writes are synchronous with the viewport
// event on purpose: deferred to a frame callback they land one frame behind
// the compositor's pan, and the header visibly chases it. Unchanged values
// are skipped, so a settled keyboard costs nothing.
import { useEffect, type RefObject } from "react";

export function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    let lastTop = -1;
    let lastHeight = -1;
    const apply = () => {
      const top = Math.round(Math.max(vv.offsetTop, window.scrollY));
      const height = Math.round(vv.height);
      if (top !== lastTop) {
        lastTop = top;
        el.style.top = top ? `${top}px` : "";
      }
      if (height !== lastHeight) {
        lastHeight = height;
        el.style.height = `${height}px`;
      }
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      el.style.top = "";
      el.style.height = "";
    };
  }, [ref]);
}
