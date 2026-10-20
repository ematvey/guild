import { describe, expect, it } from "vitest";
import { humanSchedule, nextRunLabel, scheduleLabel } from "./AgentRoutines";
import type { AgentRoutine } from "./agents-api";

function routine(patch: Partial<AgentRoutine>): AgentRoutine {
  return {
    id: "r1",
    agent_id: "a1",
    name: "Digest",
    kind: "cron",
    schedule: "0 9 * * 1-5",
    timezone: "Asia/Dubai",
    run_at: null,
    prompt: "Check the workspace.",
    context: "isolated",
    enabled: true,
    next_run_at: null,
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
    ...patch,
  };
}

describe("humanSchedule", () => {
  it("renders common cron shapes as sentences", () => {
    expect(humanSchedule("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(humanSchedule("0 9 * * *")).toBe("Daily at 09:00");
    expect(humanSchedule("30 18 * * 5")).toBe("Every Friday at 18:30");
    expect(humanSchedule("0 8 1 * *")).toBe("Monthly on day 1 at 08:00");
    expect(humanSchedule("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanSchedule("0 */2 * * *")).toBe("Every 2 hours");
  });

  it("never falls back to raw cron in the label", () => {
    const label = humanSchedule("7 3 2 4 *");
    expect(label).toBe("Custom schedule");
    expect(label).not.toContain("*");
  });
});

describe("scheduleLabel", () => {
  it("adds the timezone to a recurring routine", () => {
    expect(scheduleLabel(routine({}))).toBe("Weekdays at 09:00 · Asia/Dubai");
  });

  it("describes future runs without clamping them to just now", () => {
    const now = Date.parse("2026-10-21T00:00:00.000Z");
    expect(nextRunLabel("2026-10-21T04:30:00.000Z", now)).toBe("in 4h");
    expect(nextRunLabel("2026-10-26T05:00:00.000Z", now)).toContain("Oct");
    expect(nextRunLabel("2026-10-20T00:00:00.000Z", now)).toBe("due now");
  });

  it("formats a one-shot reminder as a date", () => {
    const label = scheduleLabel(
      routine({ kind: "once", schedule: null, run_at: "2026-10-21T09:00:00.000Z" }),
    );
    expect(label.startsWith("Once on ")).toBe(true);
    expect(label).not.toContain("2026-10-21T");
  });
});
