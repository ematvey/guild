//! About — versions of the pieces the user is actually running: the desktop
//! app (its own embedded build), the paired server (serves the web UI), the
//! newest published desktop release, and the paired server URL.

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { PageHeader } from "../components/page-header";
import { FactCard, FactGrid } from "../components/fact-card";
import { IS_TAURI, serverBase } from "../../../transport";

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function AboutSection() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [latestRelease, setLatestRelease] = useState<string | null>(null);

  useEffect(() => {
    void fetchJson(`${serverBase()}/api/v1/health`).then((h) => {
      const v = (h as { version?: string } | null)?.version ?? null;
      setServerVersion(v);
      // The web UI is the server's own build — its version is the app version.
      if (!IS_TAURI) setAppVersion(v);
    });
    if (IS_TAURI) {
      getVersion().then(setAppVersion).catch(() => {});
    }
    void fetchJson(`${serverBase()}/api/v1/updates/latest.json`).then((m) => {
      setLatestRelease((m as { version?: string } | null)?.version ?? null);
    });
  }, []);

  const base = serverBase();
  const updateAvailable =
    appVersion !== null &&
    latestRelease !== null &&
    latestRelease !== appVersion;

  return (
    <div className="space-y-4">
      <PageHeader title="About" />
      <FactGrid>
        <FactCard label="App version">
          {appVersion ?? "…"}
          {updateAvailable && (
            <span className="ml-2 text-sm text-muted-foreground">
              (update available: {latestRelease})
            </span>
          )}
        </FactCard>
        <FactCard label="Server version">{serverVersion ?? "…"}</FactCard>
        <FactCard label="Paired server">{base || "same origin (web)"}</FactCard>
        <FactCard label="Newest published release">{latestRelease ?? "none"}</FactCard>
      </FactGrid>
      {IS_TAURI && (
        <p className="text-sm text-muted-foreground">
          The desktop app embeds its own UI build — after an update, fully quit
          (tray → Quit) and relaunch. The web UI is served by the paired
          server; a browser reload always picks up its current build.
        </p>
      )}
    </div>
  );
}
