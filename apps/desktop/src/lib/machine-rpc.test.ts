import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

type Handler = (event: { payload: unknown }) => void;
const handlers: Handler[] = [];
const listenMock = vi.fn(async (_event: string, handler: Handler) => {
  handlers.push(handler);
  return () => {};
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => listenMock(event, handler),
}));

import { RPC_EVENT, rpcCall, rpcWaitersOutstanding } from "./machine-rpc";

/** Emits one engine reply the way the app process does. */
function push(payload: unknown): void {
  for (const h of handlers) h({ payload });
}

let nextId = 100;

/** `rpc_submit` acks with a fresh id, after `delayMs` when given. */
function submitAcks(delayMs = 0): number[] {
  const ids: number[] = [];
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd !== "rpc_submit") return Promise.reject(new Error(`unexpected command ${cmd}`));
    const id = nextId++;
    ids.push(id);
    return delayMs ? new Promise((r) => setTimeout(() => r(id), delayMs)) : Promise.resolve(id);
  });
  return ids;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("rpcCall push routing", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("resolves a call with the reply pushed for its id", async () => {
    const ids = submitAcks();
    const call = rpcCall("session.info", {});
    await flush();
    push({ id: ids[0], result: { base_url: "https://g", token: "t", email: "a@b" } });
    const res = await call;
    expect(res.result?.email).toBe("a@b");
    expect(listenMock).toHaveBeenCalledWith(RPC_EVENT, expect.any(Function));
    expect(rpcWaitersOutstanding()).toBe(0);
  });

  it("delivers a reply pushed before its submit ack arrived", async () => {
    const ids = submitAcks(30);
    const call = rpcCall("fs.exists", { path: "x" });
    await flush();
    // The engine answers while the submit ack is still in flight.
    push({ id: nextId - 1, result: { exists: true } });
    await expect(call).resolves.toMatchObject({ result: { exists: true } });
    expect(ids).toEqual([nextId - 1]);
    expect(rpcWaitersOutstanding()).toBe(0);
  });

  it("rejects on an error reply, including an early one", async () => {
    const ids = submitAcks();
    const late = rpcCall("pair", { code: "x" });
    await flush();
    push({ id: ids[0], error: { message: "boom" } });
    await expect(late).rejects.toThrow("boom");

    submitAcks(30);
    const early = rpcCall("login", {});
    await flush();
    push({ id: nextId - 1, error: { message: "denied" } });
    await expect(early).rejects.toThrow("denied");
    expect(rpcWaitersOutstanding()).toBe(0);
  });

  it("times out a call with no reply and drops its waiter", async () => {
    const ids = submitAcks();
    const call = rpcCall("workspace.list", {}, 20);
    await expect(call).rejects.toThrow("workspace.list timed out");
    expect(rpcWaitersOutstanding()).toBe(0);
    // A reply after the timeout settles nothing.
    expect(() => push({ id: ids[0], result: {} })).not.toThrow();
  });

  it("routes concurrent replies by id over one listener, and only submits", async () => {
    const ids = submitAcks();
    const a = rpcCall("fs.read_text", { path: "a" });
    const b = rpcCall("fs.read_text", { path: "b" });
    await flush();
    push({ id: ids[1], result: { content: "B" } });
    push({ id: ids[0], result: { content: "A" } });
    await expect(a).resolves.toMatchObject({ result: { content: "A" } });
    await expect(b).resolves.toMatchObject({ result: { content: "B" } });
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.every(([cmd]) => cmd === "rpc_submit")).toBe(true);
  });
});
