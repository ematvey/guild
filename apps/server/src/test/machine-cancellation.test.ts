import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { MachineDispatch, MachineExecutionEnv, type MachineDispatchHost } from "../machines/dispatch.js";
import { IpcMachineDispatch } from "../worker/dispatch-proxy.js";

function fixture() {
  let dispatched: { call_id: string } | undefined;
  const cancel = vi.fn(() => true);
  const hub = {
    machineHolder: () => ({ conn_id: "connection", org_id: "org" }),
    sendMachineToolDispatch: (_machine: string, _org: string, frame: { call_id: string }) => {
      dispatched = frame;
      return true;
    },
    sendMachineToolCancel: cancel,
  } as unknown as MachineDispatchHost;
  const dispatch = new MachineDispatch(hub);
  const env = new MachineExecutionEnv({
    machineId: "machine",
    orgId: "org",
    chatId: "chat",
    workdir: "/tmp",
    timeoutMs: 1000,
    dispatch,
    binaryWrites: true,
  });
  return { dispatch, env, cancel, frame: () => dispatched! };
}

describe("machine tool lifetime", () => {
  it("propagates a real caller context cancellation and ignores the late result", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = f.env.exec("sleep 30", undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith("machine", "org", "connection", f.frame().call_id);
    expect(
      f.dispatch.resolveToolResult(
        { conn_id: "connection", org_id: "org" },
        { call_id: f.frame().call_id, content: "late", is_error: false, meta: null, images: [] },
      ),
    ).toBe(false);
  });

  it("does not dispatch an already cancelled operation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await f.env.exec("sleep 30", undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    expect(result.ok).toBe(false);
    expect(f.frame()).toBeUndefined();
  });

  it("cancels the executor when its server deadline expires", async () => {
    const f = fixture();
    const pending = f.dispatch.dispatch({
      machineId: "machine",
      orgId: "org",
      chatId: "chat",
      name: "execute",
      args: {},
      workdir: "/tmp",
      timeoutMs: 10,
    });
    // The production timer is unref'd; keep the test invocation alive.
    const keepAlive = setTimeout(() => {}, 100);
    try {
      expect((await pending).is_error).toBe(true);
      expect(f.cancel).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it("a reconnect settles only that machine's in-flight calls", async () => {
    const frames: Array<{ machine: string; call_id: string }> = [];
    const hub = {
      machineHolder: (machine: string) => ({ conn_id: `${machine}-c1`, org_id: "org" }),
      sendMachineToolDispatch: (machine: string, _org: string, frame: { call_id: string }) => {
        frames.push({ machine, call_id: frame.call_id });
        return true;
      },
      sendMachineToolCancel: () => true,
    } as unknown as MachineDispatchHost;
    const dispatch = new MachineDispatch(hub);
    const call = (machineId: string) =>
      dispatch.dispatch({
        machineId,
        orgId: "org",
        chatId: "chat",
        name: "execute",
        args: {},
        workdir: "/tmp",
        timeoutMs: 60_000,
      });
    const onA = call("a");
    const onB = call("b");
    dispatch.reconcileMachine("a", "a-c2");
    expect((await onA).content).toContain("execution outcome is unknown");
    const callB = frames.find((f) => f.machine === "b")!.call_id;
    expect(
      dispatch.resolveToolResult(
        { conn_id: "b-c1", org_id: "org" },
        { call_id: callB, content: "ok", is_error: false, meta: null, images: [] },
      ),
    ).toBe(true);
    expect((await onB).content).toBe("ok");
  });

  it("carries cancellation over worker IPC before accepting any late response", async () => {
    const messages: unknown[] = [];
    let ref = 0;
    const proxy = new IpcMachineDispatch(
      (message) => messages.push(message),
      () => (ref += 1),
    );
    const controller = new AbortController();
    const call = {
      machineId: "machine",
      orgId: "org",
      chatId: "chat",
      name: "execute",
      args: {},
      workdir: "/tmp",
      timeoutMs: 1000,
    };
    const pending = proxy.dispatch(call, controller.signal);
    controller.abort();
    expect((await pending).is_error).toBe(true);
    expect(messages).toEqual([
      { t: "dispatch", ref: 1, call },
      { t: "dispatch_cancel", ref: 1 },
    ]);
    expect(proxy.onReply({ t: "reply", ref: 1, ok: true, data: {} })).toBe(false);
  });
});
