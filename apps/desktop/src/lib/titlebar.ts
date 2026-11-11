// The macOS desktop window has no native title bar: tauri.conf.json sets
// titleBarStyle Overlay with a hidden title, so the traffic lights float over
// the page and the whole window is content. Every column therefore starts
// below the band the lights occupy, and that band drags the window (a double
// click zooms it, as the native bar would).
//
// Windows and Linux keep their native decorations: the inset and the drag
// regions are off there, and the web build never gets them.

import { HAS_SHELL } from "./session";

/** The window draws its own title bar: macOS inside the desktop client. */
export const OVERLAY_TITLE_BAR = HAS_SHELL && /Mac/.test(navigator.platform ?? "");

/** Top padding of a column: the band the traffic lights sit in. */
export const TITLE_BAR_INSET = OVERLAY_TITLE_BAR ? "pt-9" : "";

/** Spread onto a column or a full-page surface so its top band moves the
 *  window. Children keep their own clicks. */
export const titleBarDrag: Record<string, string> = OVERLAY_TITLE_BAR
  ? { "data-tauri-drag-region": "" }
  : {};
