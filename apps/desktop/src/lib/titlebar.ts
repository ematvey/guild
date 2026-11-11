// The macOS desktop window has no native title bar: tauri.conf.json sets
// titleBarStyle Overlay with a hidden title, so the traffic lights float over
// the page and the whole window is content. Every column therefore starts
// below the band the lights occupy, and that band drags the window (a double
// click zooms it, as the native bar would).
//
// The Windows window is undecorated instead (tauri.windows.conf.json) and
// draws its own caption bar: the same band holds the app name and the three
// buttons, so the columns inset by the same amount.
//
// Linux keeps its native decorations: the inset and the drag regions are off
// there, and the web build never gets them.

import { HAS_SHELL } from "./session";

const PLATFORM = navigator.platform ?? "";

/** macOS: the window draws its own title bar; the traffic lights float over
 *  the sidebar. */
export const OVERLAY_TITLE_BAR = HAS_SHELL && /Mac/.test(PLATFORM);

/** Windows: the window has no frame and the app draws the caption bar. */
export const CUSTOM_TITLE_BAR = HAS_SHELL && /Win/.test(PLATFORM);

/** Top padding of a column: the band the title bar occupies. On macOS it is
 *  the height of the native title bar, so the lights keep the placement the
 *  system gives them; on Windows it matches the drawn bar. */
export const TITLE_BAR_INSET = OVERLAY_TITLE_BAR ? "pt-7" : CUSTOM_TITLE_BAR ? "pt-8" : "";

/** Spread onto a column or a full-page surface so its top band moves the
 *  window. Children keep their own clicks. */
export const titleBarDrag: Record<string, string> =
  OVERLAY_TITLE_BAR || CUSTOM_TITLE_BAR ? { "data-tauri-drag-region": "" } : {};
