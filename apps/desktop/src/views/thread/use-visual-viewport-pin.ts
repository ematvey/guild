// The keyboard shrinks the visual viewport. The shell is `position: fixed`,
// so it stays anchored to the layout viewport: it takes the visible height,
// and the document pan iOS adds to reveal the focused input is undone. Once
// the shell is as tall as the visible area, the composer sits at its bottom,
// just above the keyboard, so iOS has nothing left to reveal: the header
// stays at the top and only the message list shrinks. The shell's position
// is never written. A `top` or transform taken from the pan moves the drawn
// shell away from where iOS hit-tests it.
import { useEffect, type RefObject } from "react";

export function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    let lastHeight = -1;
    const apply = () => {
      const height = Math.round(vv.height);
      if (height !== lastHeight) {
        lastHeight = height;
        el.style.height = `${height}px`;
      }
      if (vv.offsetTop !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      el.style.height = "";
    };
  }, [ref]);
}
