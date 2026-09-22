/// Per-chat composer drafts (localStorage-backed, best-effort). Pure
/// helpers over a Storage-like object so the persistence rules — the
/// switch gate, GC, sign-out clearing — stay unit-testable without a DOM.

export const draftKey = (chatId: string | null) => `guild:draft:${chatId ?? "new"}`;

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** Whether the persist effect may write: the chatId switch effect must
 * already have restored THIS chat's draft. `undefined` = no restore ran
 * yet (first mount). Any other mismatch = a switch is mid-flight and the
 * effect sees the new chatId while the prompt still holds the previous
 * chat's text — writing then clobbers the destination draft before its
 * restore reads it. */
export function canPersistDraft(
  restoredFor: string | null | undefined,
  chatId: string | null,
): boolean {
  return restoredFor !== undefined && restoredFor === chatId;
}

/** The chat's saved composer text ("" when absent or storage is down). */
export function readDraft(storage: DraftStorage, chatId: string | null): string {
  try {
    return storage.getItem(draftKey(chatId)) ?? "";
  } catch {
    /* storage unavailable — drafts are best-effort */
    return "";
  }
}

/** Saves the composer text under the chat's key; failures are swallowed —
 * drafts are best-effort. */
export function writeDraft(storage: DraftStorage, chatId: string | null, text: string): void {
  try {
    storage.setItem(draftKey(chatId), text);
  } catch {
    /* storage unavailable — drafts are best-effort */
  }
}

/** Removes every `guild:draft:*` key whose chat is absent from `keep`.
 * The scratch draft (`draftKey(null)` → "new") never belongs to a chat
 * list and always survives. */
export function gcDrafts(storage: DraftStorage, keepChatIds: ReadonlySet<string>): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith("guild:draft:")) continue;
      const id = key.slice("guild:draft:".length);
      if (id !== "new" && !keepChatIds.has(id)) drop.push(key);
    }
    for (const key of drop) storage.removeItem(key);
  } catch {
    /* storage unavailable — drafts are best-effort */
  }
}

/** Removes every `guild:draft:*` key. Sign-out hygiene: the next account
 * on a shared browser must not inherit composer text. */
export function clearDrafts(storage: DraftStorage): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith("guild:draft:")) drop.push(key);
    }
    for (const key of drop) storage.removeItem(key);
  } catch {
    /* storage unavailable — drafts are best-effort */
  }
}
