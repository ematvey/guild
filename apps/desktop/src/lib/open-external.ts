import { IS_TAURI } from "./session";

/// Opens a URL outside the app window: through the opener plugin in the
/// Tauri webview (external navigation there would load the URL in place —
/// and cross-origin downloads have no handler), a new browser tab otherwise.
export function openExternal(url: string): void {
  if (IS_TAURI) {
    void import("@tauri-apps/plugin-opener")
      .then((m) => m.openUrl(url))
      .catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
