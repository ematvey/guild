// The per-conversation tool-call cap: the limiter itself, and the tool
// wrapper that puts an execution behind it.

import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createToolCallLimiter, MAX_TOOL_CALLS_IN_FLIGHT, withToolCallLimit } from "../harness/tool-concurrency.js";

/** A gate the test opens when it wants the held calls to continue. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const api = (conversationId: number): ToolExecutionApi => ({ conversationId }) as ToolExecutionApi;

describe("createToolCallLimiter", () => {
  it("runs at most the cap at once and finishes every call", async () => {
    const limiter = createToolCallLimiter(2);
    const hold = gate();
    let active = 0;
    let peak = 0;
    let done = 0;
    const work = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await hold.promise;
      active -= 1;
      done += 1;
    };
    const runs = Array.from({ length: 5 }, () => limiter.run(1, work));
    await Promise.resolve();
    expect(peak).toBe(2);
    hold.open();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(done).toBe(5);
  });

  it("keeps a separate cap per conversation", async () => {
    const limiter = createToolCallLimiter(1);
    const hold = gate();
    let active = 0;
    let peak = 0;
    const work = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await hold.promise;
      active -= 1;
    };
    const runs = [limiter.run(1, work), limiter.run(2, work)];
    await Promise.resolve();
    expect(peak).toBe(2);
    hold.open();
    await Promise.all(runs);
  });

  it("releases the slot when the call throws", async () => {
    const limiter = createToolCallLimiter(1);
    await expect(
      limiter.run(1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(limiter.run(1, async () => "next")).resolves.toBe("next");
  });
});

describe("withToolCallLimit", () => {
  const fake = (name: string, run: () => Promise<unknown>): ToolRegistration =>
    ({ name, description: name, execute: run }) as unknown as ToolRegistration;

  it("holds an execution until a slot is free", async () => {
    const limiter = createToolCallLimiter(1);
    const hold = gate();
    let started = 0;
    const tool = withToolCallLimit(
      fake("read", async () => {
        started += 1;
        await hold.promise;
        return { output: [{ type: "text", text: "ok" }] };
      }),
      limiter,
    );
    const first = tool.execute({}, api(1), {} as never);
    const second = tool.execute({}, api(1), {} as never);
    await Promise.resolve();
    expect(started).toBe(1);
    hold.open();
    await Promise.all([first, second]);
    expect(started).toBe(2);
  });

  it("leaves the codemode tool itself unlimited", async () => {
    const limiter = createToolCallLimiter(1);
    const tool = withToolCallLimit(
      fake("codemode", async () => "ok"),
      limiter,
    );
    expect(tool.execute).not.toBe(undefined);
    await expect(tool.execute({}, api(1), {} as never)).resolves.toBe("ok");
  });

  it("uses eight calls in flight by default", () => {
    expect(MAX_TOOL_CALLS_IN_FLIGHT).toBe(8);
  });
});
