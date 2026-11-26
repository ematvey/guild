import { HAS_SHELL } from "./session";

/// Opens a URL outside the app window: through the opener plugin in the
/// Tauri webview (external navigation there would load the URL in place —
/// and cross-origin downloads have no handler), a new browser tab otherwise.
export function openExternal(url: string, options?: { link?: boolean }): void {
  if (HAS_SHELL) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => {});
  } else if (options?.link) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.hidden = true;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
