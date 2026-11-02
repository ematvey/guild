// Desktop release manifest and downloads.

import { openExternal } from "../open-external";
import { HAS_SHELL, serverUrl } from "../session";
import { request } from "./request";

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
  try {
    const v = await request<{ releases?: Release[] }>("GET", "/api/v1/releases");
    return v?.releases ?? [];
  } catch {
    // null = the list could not be read (distinct from an empty list).
    return null;
  }
}

/// Mints a short-lived signed URL and triggers a browser download.
export async function downloadRelease(id: string): Promise<void> {
  const v = await request<{ url: string }>("GET", `/api/v1/releases/${encodeURIComponent(id)}/download-url`);
  // The server returns a root-relative signed path; in the Tauri webview a
  // relative href resolves against tauri://localhost and the download
  // fails. Resolve against the paired server (the page origin in the
  // browser). The native app hands the signed URL to the system browser —
  // a programmatic cross-origin <a download> click either navigates the
  // webview or does nothing (no download handler).
  const url = String(v.url).startsWith("/") ? `${serverUrl()}${v.url}` : v.url;
  if (HAS_SHELL) {
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
