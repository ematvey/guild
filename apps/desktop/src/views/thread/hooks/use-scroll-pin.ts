// The transcript pane's scroll geometry: the saved reading position per
// chat, the older-page anchor, and the bottom pin that follows a live turn
// while the reader is at the bottom. The scroll handler keeps
// `stick.current` truthful; scrolling up detaches into free scroll and
// scrolling back to the last character re-attaches.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { RenderBlock } from "../../../lib/thread-reducer";

export function useScrollPin(input: {
  pane: RefObject<HTMLDivElement | null>;
  stick: RefObject<boolean>;
  setAtBottom: (atBottom: boolean) => void;
  /** Set by a swap: the reading position the displayed chat returns to. */
  scrollRestoreRef: RefObject<{ chatId: string | null; top: number; atBottom: boolean } | null>;
  /** Set before an older page is prepended: the geometry to hold. */
  earlierAnchor: RefObject<{ height: number; top: number } | null>;
  displayedChatId: string | null;
  blocks: RenderBlock[];
  /** State-only height changes with no block change (the subagent tree,
   *  compaction line, working indicator, banners, the older-page button). */
  repinKeys: readonly unknown[];
  /** The reader scrolled near the top of the loaded window. */
  onNearTop: () => void;
}) {
  const {
    pane, stick, setAtBottom, scrollRestoreRef, earlierAnchor, displayedChatId, blocks,
    repinKeys, onNearTop,
  } = input;
  // The composer floats over the chat content; the scroll pane needs its
  // live height as bottom padding — a fixed guess breaks as soon as the
  // composer stack grows (queued chips, attachments, a taller textarea).
  // The element arrives via callback ref: the Skills/Settings routes swap
  // the whole chat column out, so the composer remounts and an
  // observe-once effect would keep watching the detached node while the
  // padding froze at a stale height.
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);
  const [composerH, setComposerH] = useState(128);
  // The content column is observed together with the pane: any change in
  // either height re-pins the bottom while the reader is at the bottom.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const anchorGuard = useRef(false);
  useEffect(() => {
    if (!composerEl) return;
    const ro = new ResizeObserver(() => setComposerH(composerEl.offsetHeight));
    ro.observe(composerEl);
    setComposerH(composerEl.offsetHeight);
    return () => ro.disconnect();
  }, [composerEl]);

  // Restore the visible chat's saved reading position once per swap. A chat
  // that was at the bottom (or was never opened) pins to the bottom; one
  // that was scrolled up returns to the same offset.
  useLayoutEffect(() => {
    const restore = scrollRestoreRef.current;
    if (!restore) return;
    const el = pane.current;
    if (!el) return;
    scrollRestoreRef.current = null;
    if (restore.atBottom) {
      stick.current = true;
      setAtBottom(true);
      el.scrollTop = el.scrollHeight;
    } else {
      stick.current = false;
      setAtBottom(false);
      el.scrollTop = restore.top;
    }
  }, [displayedChatId, blocks, scrollRestoreRef]);

  // Scroll anchor for the older-page prepend: keep the reader on the same
  // content after blocks are inserted above the viewport. The guard keeps
  // the observer's bottom pin from running over this restore in the same
  // frame.
  useLayoutEffect(() => {
    const anchor = earlierAnchor.current;
    const el = pane.current;
    if (!anchor || !el) return;
    earlierAnchor.current = null;
    el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
    anchorGuard.current = true;
    requestAnimationFrame(() => { anchorGuard.current = false; });
  }, [blocks]);

  // State-only height changes have no block change to trigger the observer.
  // Re-pin them explicitly; the observer covers the rest.
  useLayoutEffect(() => {
    if (!stick.current || anchorGuard.current) return;
    const el = pane.current;
    if (el) el.scrollTop = el.scrollHeight;
    // The caller's repin keys are a dependency list of their own, spread in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...repinKeys, composerH, displayedChatId]);

  // Geometry pin: observe the content column and the pane. The observer
  // catches late blocks, removed tail blocks, window/sidebar/column resizes
  // and the mobile keyboard's visual-viewport shrink. One rAF coalesces a
  // burst of resize callbacks into one scroll write.
  const empty = blocks.length === 0;
  useEffect(() => {
    const paneEl = pane.current;
    if (!paneEl || !contentEl) return;
    let raf = 0;
    const pin = () => {
      if (!stick.current || anchorGuard.current) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!stick.current || anchorGuard.current) return;
        paneEl.scrollTop = paneEl.scrollHeight;
      });
    };
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    observer.observe(paneEl);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [contentEl, displayedChatId, empty]);

  const onScroll = useCallback(() => {
    const el = pane.current;
    if (!el) return;
    // near-bottom counts as bottom (sub-pixel/rounding slack)
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    stick.current = near;
    setAtBottom(near);
    if (el.scrollTop < 120) onNearTop();
  }, [pane, stick, setAtBottom, onNearTop]);

  const scrollToBottom = useCallback(() => {
    const el = pane.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [pane, stick, setAtBottom]);

  // A frame toggle grows the content under the reader. Stop following the
  // bottom, or the pin scrolls the row that was just clicked out from under
  // the pointer one frame after the click.
  const onFrameToggle = useCallback(() => {
    stick.current = false;
    setAtBottom(false);
  }, [stick, setAtBottom]);

  return { composerH, setComposerEl, setContentEl, onScroll, scrollToBottom, onFrameToggle };
}
