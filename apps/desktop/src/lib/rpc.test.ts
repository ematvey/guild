import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

import { rpcCall, rpcWaitersOutstanding } from "./machine-rpc";

describe("rpcCall poll routing", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("delivers a result that was polled before its waiter registered", async () => {
    let submits = 0;
    let polls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "rpc_submit") {
        submits += 1;
        if (submits === 1) return Promise.resolve(1);
        // Call B completes in the engine before its submit ack reaches
        // the webview: the poll loop drains B's result while B's caller
        // is still awaiting rpc_submit.
        return new Promise((r) => setTimeout(() => r(2), 30));
      }
      if (cmd === "rpc_poll") {
        polls += 1;
        if (polls === 1) {
          return Promise.resolve([
            { id: 1, result: { ok: "a" } },
            { id: 2, result: { ok: "b" } },
          ]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });

    const a = rpcCall("m1", {});
    const b = rpcCall("m2", {});
    await expect(a).resolves.toMatchObject({ result: { ok: "a" } });
    await expect(b).resolves.toMatchObject({ result: { ok: "b" } });
  });

  it("routes an orphaned error envelope to the late waiter", async () => {
    let submits = 0;
    let polls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "rpc_submit") {
        submits += 1;
        if (submits === 1) return Promise.resolve(1);
        return new Promise((r) => setTimeout(() => r(2), 30));
      }
      if (cmd === "rpc_poll") {
        polls += 1;
        if (polls === 1) {
          return Promise.resolve([
            { id: 1, result: {} },
            { id: 2, error: { message: "boom" } },
          ]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });

    const a = rpcCall("m1", {});
    const b = rpcCall("m2", {});
    await expect(a).resolves.toMatchObject({ id: 1 });
    await expect(b).rejects.toThrow("boom");
  });

  it("orphan pickup clears the waiter so the poll loop exits", async () => {
    let submits = 0;
    let polls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "rpc_submit") {
        submits += 1;
        // Call B settles in the engine before its submit ack reaches the
        // webview, so the first poll (driven by call A) stores B's result
        // as an orphan and B settles through the pickup path.
        if (submits === 2) return new Promise((r) => setTimeout(() => r(2), 30));
        return Promise.resolve(1);
      }
      if (cmd === "rpc_poll") {
        polls += 1;
        if (polls === 1) {
          return Promise.resolve([
            { id: 1, result: { ok: "a" } },
            { id: 2, result: { ok: "early" } },
          ]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });

    const a = rpcCall("m1", {});
    const b = rpcCall("m2", {});
    await expect(a).resolves.toMatchObject({ result: { ok: "a" } });
    await expect(b).resolves.toMatchObject({ result: { ok: "early" } });
    expect(rpcWaitersOutstanding()).toBe(0);
    // The poll loop must exit once no waiters remain: the count freezes.
    await new Promise((r) => setTimeout(r, 300));
    const frozen = polls;
    await new Promise((r) => setTimeout(r, 300));
    expect(polls).toBe(frozen);
  });
});
