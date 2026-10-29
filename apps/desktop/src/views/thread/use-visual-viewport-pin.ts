// The keyboard shrinks the visual viewport; a fixed shell is anchored to the
// visual viewport, so the document pan needs no correction — but the shell
// still has to take the visible height, or the composer sits under the
// keyboard. Only the height is written. Writing `top` from the pan shifts the
// whole shell away from where iOS hit-tests it: in landscape the toolbar
// leaves the document scrollable, the pan is nonzero with no keyboard, and
// every tap then lands somewhere the user did not press.
import { useEffect, type RefObject } from "react";

export function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    let lastHeight = -1;
    const apply = () => {
      const height = Math.round(vv.height);
      if (height === lastHeight) return;
      lastHeight = height;
      el.style.height = `${height}px`;
    };
    apply();
    vv.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      el.style.height = "";
    };
  }, [ref]);
}
