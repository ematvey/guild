// One resizable sidebar width shared by the chat and settings sidebars:
// both read, clamp and persist the same value.

export const SIDEBAR_WIDTH_KEY = "guild.sidebarWidth";
export const SIDEBAR_MIN_W = 200;
export const SIDEBAR_MAX_W = 420;
export const SIDEBAR_DEFAULT_W = 256;

export function clampSidebarWidth(w: number): number {
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, w));
}

export function storedSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return stored ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_W;
}

export function saveSidebarWidth(w: number): void {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
  // same-tab resync: storage events only fire cross-tab
  window.dispatchEvent(new Event("guild:sidebar-width-changed"));
}
