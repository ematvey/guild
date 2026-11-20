// Desktop release manifest and downloads.

import { openExternal } from "../open-external";
import { HAS_SHELL, serverUrl } from "../session";
import { request } from "./request";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceIdentity } from "../workspace-store";

export type UpdateChannel = "stable" | "develop";
export interface UpdateStatus {
  channel: UpdateChannel;
  phase: "idle" | "checking" | "ready" | "error" | "disabled" | "installing";
  pending_version: string | null;
  message: string | null;
}

/** Native pushes own installation preferences and updater progress. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const base = HAS_SHELL ? serverUrl() : "";
  const serverVersion = useWorkspaceIdentity()?.server_version;
  useEffect(() => {
    if (!HAS_SHELL) return;
    let disposed = false;
    let pushed = false;
    setStatus(null);
    const listening = listen<UpdateStatus>("update-status", (event) => {
      pushed = true;
      if (!disposed) setStatus(event.payload);
    });
    void listening
      .then(async () => {
        await invoke("check_update_now", { force: true, serverVersion });
        return invoke<UpdateStatus>("update_status");
      })
      .then((snapshot) => {
        if (!disposed && !pushed) setStatus(snapshot);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      void listening.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [base, serverVersion]);
  return status;
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  await invoke("set_update_channel", { channel });
}

async function releaseQuery(): Promise<string> {
  if (!HAS_SHELL) return "";
  const status = await invoke<UpdateStatus>("update_status");
  return `?channel=${status.channel}`;
}

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
    const v = await request<{ releases?: Release[] }>("GET", `/api/v1/releases${await releaseQuery()}`);
    return v?.releases ?? [];
  } catch {
    // null = the list could not be read (distinct from an empty list).
    return null;
  }
}

/** Opens an approved GitHub artifact after server eligibility checks. */
export async function downloadRelease(id: string): Promise<void> {
  const v = await request<{ url: string }>(
    "GET",
    `/api/v1/releases/${encodeURIComponent(id)}/download-url${await releaseQuery()}`,
  );
  // Native hands the GitHub URL to the system browser; web uses a download link.
  const url = v.url;
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
