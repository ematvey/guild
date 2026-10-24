// Desktop release manifest and downloads.

import { openExternal } from "../open-external";
import { IS_TAURI, apiUrl, getToken, serverUrl } from "../session";

export interface Release {
  id: string;
  version: string;
  kind: string;
  platform: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export async function listReleases(): Promise<Release[] | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/releases"), {
    headers: { authorization: `Bearer ${token}` },
  });
  // null = request failed (distinguishable from a legitimately empty list)
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v.releases ?? [];
}

/// Mints a short-lived signed URL and triggers a browser download.
export async function downloadRelease(id: string): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/releases/${id}/download-url`), {
    headers: { authorization: `Bearer ${token}` },
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  // The server returns a root-relative signed path; in the Tauri webview a
  // relative href resolves against tauri://localhost and the download
  // fails. Resolve against the paired server (the page origin in the
  // browser). The native app hands the signed URL to the system browser —
  // a programmatic cross-origin <a download> click either navigates the
  // webview or does nothing (no download handler).
  const url = String(v.url).startsWith("/") ? `${serverUrl()}${v.url}` : v.url;
  if (IS_TAURI) {
    openExternal(url);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

