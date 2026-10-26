// The window title: "<workspace name> - Guild". The member socket pushes
// the workspace identity on connect and on every rename, so the title is
// server state, never a fetch or a poll.

import { IS_TAURI } from "./session";

/** The title when the workspace has no name yet (sign-in, first paint). */
export const APP_TITLE = "Guild";

/** The title for a workspace name. An empty or blank name falls back to
 *  the bare app name. */
export function windowTitle(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed === "" ? APP_TITLE : `${trimmed} - ${APP_TITLE}`;
}

/** Sets the title on the browser tab and, in the desktop client, on the
 *  native window (the webview title does not reach it). */
export function applyWindowTitle(name: string | null | undefined): void {
  const title = windowTitle(name);
  if (typeof document !== "undefined") document.title = title;
  if (!IS_TAURI) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {});
}
