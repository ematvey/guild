//! About — versions of the pieces the user is actually running: the desktop
//! app (its own embedded build), the paired server (serves the web UI), the
//! newest published desktop release, and the paired server URL.

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Button } from "@guild/ui/components/button";
import { setUpdateChannel, useUpdateStatus, type UpdateChannel } from "../../../lib/api/releases";
import { PageHeader } from "../../../components/page-header";
import { FactCard, FactGrid } from "../components/fact-card";
import { HAS_SHELL, serverBase } from "../../../lib/session";
import { useWorkspaceIdentity } from "../../../lib/workspace-store";

export function AboutSection() {
  const identity = useWorkspaceIdentity();
  const updates = useUpdateStatus();
  const [savingChannel, setSavingChannel] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null | undefined>(undefined);
  const serverVersion = identity?.server_version;
  // Read-only and live: the switch is the workspace admin's (Settings →
  // General), and the workspace-identity frame carries it.
  const telemetry = identity?.telemetry ?? null;
  const [trace, setTrace] = useState<{
    enabled: boolean;
    path: string;
  } | null>(null);

  useEffect(() => {
    if (HAS_SHELL) {
      void invoke<{ enabled: boolean; path: string }>("daemon_trace_state")
        .then(setTrace)
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (HAS_SHELL) {
      getVersion()
        .then(setAppVersion)
        .catch(() => setAppVersion(null));
    }
  }, []);

  const base = serverBase();

  return (
    <div className="space-y-4">
      <PageHeader title="About" description="Version, updates, and diagnostics for this installation." />
      <FactGrid>
        <FactCard label="App version">
          {HAS_SHELL ? (
            appVersion === undefined ? (
              <Skeleton className="my-1 h-4 w-20" />
            ) : (
              (appVersion ?? "Unavailable")
            )
          ) : serverVersion === undefined ? (
            <Skeleton className="my-1 h-4 w-20" />
          ) : (
            (serverVersion ?? "Unavailable")
          )}
        </FactCard>
        <FactCard label="Server version">
          {serverVersion === undefined ? <Skeleton className="my-1 h-4 w-20" /> : (serverVersion ?? "Unavailable")}
        </FactCard>
        <FactCard label="Paired server">{base || "same origin (web)"}</FactCard>
        <FactCard label="Telemetry">
          {telemetry === null ? (
            <Skeleton className="my-1 h-4 w-20" />
          ) : (
            <span className="text-sm text-muted-foreground">
              {telemetry
                ? "On — this workspace collects app diagnostics (errors, socket trace, performance)."
                : "Off — nothing is collected. Your workspace admin controls this."}
            </span>
          )}
        </FactCard>
        {HAS_SHELL && (
          <FactCard label="Updates">
            <label htmlFor="update-channel" className="text-sm font-medium">
              Update channel
            </label>
            <select
              id="update-channel"
              className="mt-2 h-9 w-full rounded-md border border-input bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={updates?.channel ?? ""}
              disabled={!updates || savingChannel || updates.phase === "installing"}
              onChange={(event) => {
                setSavingChannel(true);
                setChannelError(null);
                void setUpdateChannel(event.target.value as UpdateChannel)
                  .catch(() => setChannelError("Could not save the update channel. Try again."))
                  .finally(() => setSavingChannel(false));
              }}
            >
              {!updates && (
                <option value="" disabled>
                  Loading channel…
                </option>
              )}
              <option value="stable">Stable</option>
              <option value="develop">Develop</option>
            </select>
            <p className="mt-2 text-sm text-muted-foreground">
              Saved for this installation. Updates stop at your server’s version.
            </p>
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              {!updates
                ? "Loading update settings…"
                : updates.phase === "checking"
                  ? "Checking for updates…"
                  : updates?.pending_version
                    ? `Version ${updates.pending_version} is ready to install.`
                    : updates?.phase === "disabled"
                      ? "Automatic updates are off in local development."
                      : "No eligible update is ready."}
            </p>
            {(channelError || updates?.message) && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {channelError ?? updates?.message}
              </p>
            )}
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              disabled={
                !updates ||
                updates.phase === "checking" ||
                updates.phase === "installing" ||
                updates.phase === "disabled"
              }
              onClick={() => {
                void invoke("check_update_now", { force: true }).catch(() => {});
              }}
            >
              Check for updates
            </Button>
          </FactCard>
        )}
      </FactGrid>
      {HAS_SHELL && (
        <p className="text-sm text-muted-foreground">
          The desktop app embeds its own UI build — after an update, fully quit (tray → Quit) and relaunch. The web UI
          is served by the paired server; a browser reload always picks up its current build.
        </p>
      )}
      {HAS_SHELL && trace && (
        <FactCard label="Daemon trace">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {trace.enabled
                ? `On — machine-link diagnostics append to ${trace.path}.`
                : `Off. When on, machine-link diagnostics append to ${trace.path} (useful when this machine keeps dropping offline).`}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const on = !trace.enabled;
                void invoke("set_daemon_trace", { on })
                  .then(() => invoke<{ enabled: boolean; path: string }>("daemon_trace_state").then(setTrace))
                  .catch(() => {});
              }}
            >
              {trace.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </FactCard>
      )}
    </div>
  );
}
