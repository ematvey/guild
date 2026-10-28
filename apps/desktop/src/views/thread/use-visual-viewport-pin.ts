// The keyboard shrinks the visual viewport and pans the document; a fixed
// shell is anchored to the layout viewport, so it takes both the visible
// height and the pan. No page API runs in the same frame as that pan, so the
// header moves during the transition; the end state is exact.
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
      if (top === lastTop && height === lastHeight) return;
      lastTop = top;
      lastHeight = height;
      el.style.top = top ? `${top}px` : "";
      el.style.height = `${height}px`;
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
