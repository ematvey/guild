// iOS Safari does not shrink the layout viewport when the keyboard opens —
// it overlays it and pans the page to reveal the focused input, dragging
// the fixed app shell (header included) off-screen. Pin the shell to the
// visual viewport while that state lasts: same top offset, same visible
// height, tracked live on every viewport resize/scroll. Android browsers
// either resize the layout viewport natively (interactive-widget=
// resizes-content) or report a shrunk visual viewport — both land here
// correctly; when no keyboard is up the shell keeps plain `fixed inset-0`
// (empty inline styles), so normal browsing is untouched.
//
// A shorter visual viewport alone is not proof of a keyboard: an installed
// web app can report one while the screen is fully visible, and pinning
// there leaves a dead strip at the bottom. So the pin also requires a
// focused editable element — the only thing that can raise the keyboard.
import { useEffect, type RefObject } from "react";

function editableFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

export function useVisualViewportPin(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    const apply = () => {
      const layoutH = document.documentElement.clientHeight;
      const pinned =
        editableFocused() && (vv.height < layoutH - 60 || vv.offsetTop > 0);
      if (!pinned) {
        el.style.top = "";
        el.style.height = "";
        return;
      }
      el.style.top = `${Math.max(0, vv.offsetTop)}px`;
      el.style.height = `${vv.height}px`;
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    document.addEventListener("focusin", apply);
    document.addEventListener("focusout", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", apply);
      el.style.top = "";
      el.style.height = "";
    };
  }, [ref]);
}
