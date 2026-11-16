// The macOS desktop window has no native title bar: tauri.conf.json sets
// titleBarStyle Overlay with a hidden title, so the traffic lights float over
// the page and the whole window is content. Every column therefore starts
// below the band the lights occupy, and that band drags the window (a double
// click zooms it, as the native bar would).
//
// The Windows window is undecorated instead (tauri.windows.conf.json) and
// draws only the three caption buttons. They sit in the first row of the
// columns, at the right edge, over a box that row reserves: no bar, no label,
// no divider, so the columns' own backgrounds reach the window edge.
//
// Linux keeps its native decorations: the inset and the drag regions are off
// there, and the web build never gets them.

import { HAS_SHELL } from "./session";

const PLATFORM = navigator.platform ?? "";

/** macOS: the window draws its own title bar; the traffic lights float over
 *  the sidebar. */
export const OVERLAY_TITLE_BAR = HAS_SHELL && /Mac/.test(PLATFORM);

/** Windows: the window has no frame and the app draws the caption buttons. */
export const CUSTOM_TITLE_BAR = HAS_SHELL && /Win/.test(PLATFORM);

/** Top padding of a column: the band the caption controls float over. On
 *  macOS it is the height of the native title bar, so the lights keep the
 *  placement the system gives them; on Windows the columns start at the
 *  window edge and the drawn buttons sit in the first row. */
export const TITLE_BAR_INSET = OVERLAY_TITLE_BAR ? "pt-7" : "";

/** The first row of every column — the rail's logo, a list header, the thread
 *  header. One height, so the three columns and the caption buttons share a
 *  baseline. */
export const TOP_ROW = "h-14";

/** Right padding of a first row that reaches the window's right edge: the box
 *  the Windows caption buttons occupy, so no control sits under them. */
export const CAPTION_BUTTONS_INSET = CUSTOM_TITLE_BAR ? "pr-[138px]" : "";

/** Spread onto a column or a full-page surface so its top band moves the
 *  window. Children keep their own clicks. */
export const titleBarDrag: Record<string, string> =
  OVERLAY_TITLE_BAR || CUSTOM_TITLE_BAR ? { "data-tauri-drag-region": "" } : {};
