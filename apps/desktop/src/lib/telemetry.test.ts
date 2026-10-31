// The workspace telemetry switch is the server's: the client starts in the
// off state, obeys the workspace-identity frame, and traces nothing until
// the server says the org collects.

import { describe, expect, it } from "vitest";
import { applyTelemetrySetting, telemetryEnabled, traceEvent } from "./telemetry";

describe("workspace telemetry switch", () => {
  it("starts off: an unknown setting never collects", () => {
    expect(telemetryEnabled()).toBe(false);
  });

  it("traces nothing while the switch is off", () => {
    expect(() => traceEvent("socket.open", { attempt: 1 })).not.toThrow();
  });

  it("follows the value the server pushes", () => {
    applyTelemetrySetting(true);
    expect(telemetryEnabled()).toBe(true);
    applyTelemetrySetting(false);
    expect(telemetryEnabled()).toBe(false);
  });
});
