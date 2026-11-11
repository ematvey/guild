// The one sidebar width and the one collapse flag. Every page's sidebar —
// chats, projects, settings, apps, integrations — reads and persists these
// values, so a resize or a collapse holds across pages.

export const SIDEBAR_WIDTH_KEY = "guild.sidebarWidth";
export const SIDEBAR_COLLAPSED_KEY = "guild.sidebarCollapsed";
export const SIDEBAR_MIN_W = 200;
export const SIDEBAR_MAX_W = 420;
export const SIDEBAR_DEFAULT_W = 256;

/** Same-tab sync: storage events only fire across tabs. */
export const SIDEBAR_WIDTH_EVENT = "guild:sidebar-width-changed";
export const SIDEBAR_COLLAPSED_EVENT = "guild:sidebar-collapsed-changed";

export function clampSidebarWidth(w: number): number {
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, w));
}

export function storedSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return stored ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_W;
}

export function saveSidebarWidth(w: number): void {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
  window.dispatchEvent(new Event(SIDEBAR_WIDTH_EVENT));
}

export function storedSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  window.dispatchEvent(new Event(SIDEBAR_COLLAPSED_EVENT));
}
