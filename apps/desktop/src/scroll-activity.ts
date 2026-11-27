// Floating scrollbars: native scrollbars are hidden by the theme CSS and
// take no space; this tracker renders a floating thumb over the right edge
// of every scrolling container and shows it only while that container is
// being scrolled. Thumbs are hidden between scrolls, so stale geometry
// self-heals on the next scroll event.

const IDLE_MS = 700;
const THUMB_W = 6;
const MIN_THUMB_H = 24;

const thumbs = new WeakMap<Element, HTMLDivElement>();
const timers = new WeakMap<Element, number>();

function thumbFor(el: Element): HTMLDivElement {
  let t = thumbs.get(el);
  if (!t) {
    t = document.createElement("div");
    t.className = "floating-scrollbar-thumb";
    document.body.appendChild(t);
    thumbs.set(el, t);
  }
  return t;
}

function update(el: Element, show: boolean) {
  if (!(el instanceof HTMLElement)) return;
  const t = thumbFor(el);
  const maxScroll = el.scrollHeight - el.clientHeight;
  // no overflow (or element gone): hide, and drop the thumb if unmounted
  if (maxScroll <= 1 || !el.isConnected) {
    t.style.opacity = "0";
    if (!el.isConnected) t.remove();
    return;
  }
  const rect = el.getBoundingClientRect();
  const trackTop = rect.top + 4;
  const trackH = Math.max(0, rect.height - 8);
  const h = Math.max(MIN_THUMB_H, (trackH * el.clientHeight) / el.scrollHeight);
  const y = trackTop + (trackH - h) * (el.scrollTop / maxScroll);
  t.style.transform = `translate(${Math.round(rect.right - THUMB_W - 1)}px, ${Math.round(y)}px)`;
  t.style.height = `${Math.round(h)}px`;
  t.style.opacity = show ? "1" : "0";
}

function reveal(el: Element) {
  update(el, true);
  const prev = timers.get(el);
  if (prev !== undefined) clearTimeout(prev);
  timers.set(
    el,
    window.setTimeout(() => update(el, false), IDLE_MS),
  );
}

// scroll does not bubble, so capture every scroll event on the way down
document.addEventListener(
  "scroll",
  (e) => {
    if (e.target instanceof Element && !e.target.classList.contains("work-sidebar-scroll")) reveal(e.target);
    else if (e.target === document) reveal(document.documentElement);
  },
  { capture: true, passive: true },
);
