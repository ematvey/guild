// The one preview-pane width. The pane keeps the chat column at its own fixed
// width and takes the rest of the row, so this value is the space the drag
// gives the pane; it holds across pages and reloads.

export const PREVIEW_WIDTH_KEY = "guild.previewWidth";
export const PREVIEW_MIN_W = 352;
export const PREVIEW_MAX_W = 900;
export const PREVIEW_DEFAULT_W = 640;

/** Same-tab sync: storage events only fire across tabs. */
export const PREVIEW_WIDTH_EVENT = "guild:preview-width-changed";

export function clampPreviewWidth(w: number): number {
  return Math.min(PREVIEW_MAX_W, Math.max(PREVIEW_MIN_W, w));
}

export function storedPreviewWidth(): number {
  const stored = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
  return stored ? clampPreviewWidth(stored) : PREVIEW_DEFAULT_W;
}

export function savePreviewWidth(w: number): void {
  localStorage.setItem(PREVIEW_WIDTH_KEY, String(w));
  window.dispatchEvent(new Event(PREVIEW_WIDTH_EVENT));
}
