// Width of the central conversation column: the message list, the composer
// and the loading skeleton read the same value, so the drag handle moves
// them together.

export const CHAT_WIDTH_KEY = "guild.chatWidth";
export const CHAT_MIN_W = 480;
export const CHAT_MAX_W = 1400;
export const CHAT_DEFAULT_W = 768; // max-w-3xl

export function clampChatWidth(w: number): number {
  return Math.min(CHAT_MAX_W, Math.max(CHAT_MIN_W, w));
}

export function storedChatWidth(): number {
  const stored = Number(localStorage.getItem(CHAT_WIDTH_KEY));
  return stored ? clampChatWidth(stored) : CHAT_DEFAULT_W;
}

export function saveChatWidth(w: number): void {
  localStorage.setItem(CHAT_WIDTH_KEY, String(w));
  // same-tab resync: storage events only fire cross-tab
  window.dispatchEvent(new Event("guild:chat-width-changed"));
}
