import { describe, expect, it } from "vitest";
import { childElapsedLabel, childStatusLabel, childStatusTone } from "./child-row";
import type { ChildRow } from "../../lib/thread-reducer";

const row: ChildRow = {
  threadId: "t1",
  agentName: "Researcher",
  status: "running",
  startedAt: "2026-10-22T10:00:00.000Z",
};

describe("child row formatting", () => {
  it("computes elapsed on the client from started_at", () => {
    expect(childElapsedLabel(row, Date.parse("2026-10-22T10:00:42.000Z"))).toBe("42s");
    expect(childElapsedLabel(row, Date.parse("2026-10-22T10:03:07.000Z"))).toBe("3m 07s");
    expect(childElapsedLabel(row, Date.parse("2026-10-22T12:05:00.000Z"))).toBe("2h 05m");
  });

  it("stops at finished_at when the child is terminal", () => {
    expect(
      childElapsedLabel(
        { ...row, status: "succeeded", finishedAt: "2026-10-22T10:00:05.000Z" },
        Date.parse("2026-10-22T11:00:00.000Z"),
      ),
    ).toBe("5s");
  });

  it("maps status to a dot tone and label", () => {
    expect(childStatusTone("running")).toBe("running");
    expect(childStatusTone("succeeded")).toBe("success");
    expect(childStatusTone("failed")).toBe("danger");
    expect(childStatusTone("cancelled")).toBe("muted");
    expect(childStatusLabel("cancelled")).toBe("Cancelled");
  });
});
