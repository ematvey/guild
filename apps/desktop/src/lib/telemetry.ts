//! Faro telemetry: browser diagnostics (errors, console, web vitals, session,
//! and the app's own socket/busy trace events) sent to the workspace's Faro
//! collector through the paired server's /faro/collect proxy. The switch is
//! the ORG's: the server pushes it on the workspace-identity frame and an
//! admin owns the only control (Settings → General). Clients never decide
//! this themselves — a fresh workspace collects until an admin turns it off.
//! The SDK is dynamically imported so the chat bundle pays for it only while
//! the switch is on.

import { HAS_SHELL, serverBase } from "./session";

const COLLECT_PATH = "/faro/collect";

type FaroHandle = {
  pause: () => void;
  unpause: () => void;
  api: {
    pushEvent: (
      name: string,
      attributes?: Record<string, string>,
      domain?: string,
      options?: { skipDedupe?: boolean },
    ) => void;
  };
};

let faro: FaroHandle | null = null;
// Set when the SDK chunk loaded and faro was paused (switch off); a later
// enable resumes instead of re-initializing.
let paused = false;
// The switch the server last pushed. Off until it arrives: an unknown
// setting must never collect.
let enabled = false;

/** Per-event-name send budget: the socket trace repeats on every reconnect,
 *  and a churn loop must not flood the collector. */
const TRACE_BUDGET_PER_NAME = 300;
const traceCounts = new Map<string, number>();

/** The workspace's telemetry switch, as the server pushed it. */
export function telemetryEnabled(): boolean {
  return enabled;
}

/** Applies the server's switch: starts the SDK, or stops collecting. The
 *  only writer is the workspace-identity frame handler. */
export function applyTelemetrySetting(on: boolean): void {
  enabled = on;
  if (on) {
    if (faro) {
      if (paused) {
        faro.unpause();
        paused = false;
      }
    } else {
      void startTelemetry();
    }
    return;
  }
  if (faro) {
    faro.pause();
    paused = true;
  }
}

/// Starts Faro when the workspace switch is on and a collector route is
/// resolvable. Idempotent; safe to call on every boot and after pairing.
export async function startTelemetry(): Promise<void> {
  if (!enabled || faro) return;
  // Web mode: same-origin, resolvable immediately. Tauri: needs the paired
  // server URL (stored at afterAuth) — pre-pairing there is no target.
  const base = HAS_SHELL ? serverBase() : "";
  if (HAS_SHELL && !base) return;
  try {
    const { initializeFaro } = await import("@grafana/faro-web-sdk");
    if (faro) return;
    faro = initializeFaro({
      url: `${base}${COLLECT_PATH}`,
      app: { name: "guild" },
    });
    if (!enabled) {
      faro.pause();
      paused = true;
    }
  } catch {
    /* best-effort: unreachable collector or failed chunk is not an app error */
  }
}

/** One diagnostics event. A no-op unless the workspace switch is on and the
 *  SDK is running, so trace call sites stay unconditional. Attributes are
 *  strings by the Faro contract; never pass message text or thread content. */
export function traceEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
  if (!enabled || faro === null || paused) return;
  const sent = traceCounts.get(name) ?? 0;
  if (sent >= TRACE_BUDGET_PER_NAME) return;
  traceCounts.set(name, sent + 1);
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) flat[key] = String(value);
  try {
    faro.api.pushEvent(name, flat, "guild", { skipDedupe: true });
  } catch {
    /* the collector path must never break the UI */
  }
}
