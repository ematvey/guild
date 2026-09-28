//! Optional Faro telemetry: opt-in browser diagnostics (errors, console,
//! web vitals, session) sent to the org's Faro collector through the paired
//! server's /faro/collect proxy. Off by default; the toggle lives in
//! Settings → About. The SDK is dynamically imported so the chat bundle only
//! pays for it when the user opted in.

import { IS_TAURI, serverBase } from "../transport";

const KEY = "guild.faro.enabled";
const COLLECT_PATH = "/faro/collect";

type FaroHandle = { pause: () => void; unpause: () => void };

let faro: FaroHandle | null = null;
// Set when the SDK chunk loaded and faro was paused (toggle off); a later
// enable resumes instead of re-initializing.
let paused = false;

export function telemetryEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setTelemetryEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode: session-only */
  }
  if (on) {
    if (faro) {
      faro.unpause();
      paused = false;
    } else {
      void startTelemetry();
    }
  } else {
    faro?.pause();
    paused = true;
  }
}

/// Starts Faro if the user opted in and a collector route is resolvable.
/// Idempotent; safe to call on every boot and after pairing.
export async function startTelemetry(): Promise<void> {
  if (!telemetryEnabled() || faro) return;
  // Web mode: same-origin, resolvable immediately. Tauri: needs the paired
  // server URL (stored at afterAuth) — pre-pairing there is no target.
  const base = IS_TAURI ? serverBase() : "";
  if (IS_TAURI && !base) return;
  try {
    const { initializeFaro } = await import("@grafana/faro-web-sdk");
    if (faro) return;
    faro = initializeFaro({
      url: `${base}${COLLECT_PATH}`,
      app: { name: "guild" },
    });
    if (paused) {
      faro.pause();
      paused = false;
    }
  } catch {
    /* best-effort: unreachable collector or failed chunk is not an app error */
  }
}
