import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { MachineDispatch, MachineExecutionEnv, type MachineDispatchHost } from "../machines/dispatch.js";
import { IpcMachineDispatch } from "../worker/dispatch-proxy.js";

function fixture() {
  let dispatched: { call_id: string } | undefined;
  const cancel = vi.fn(() => true);
  const hub = {
    machineHolder: () => ({ conn_id: "connection", org_id: "org" }),
    sendMachineToolDispatch: (_machine: string, _org: string, frame: { call_id: string }) => { dispatched = frame; return true; },
    sendMachineToolCancel: cancel,
  } as unknown as MachineDispatchHost;
  const dispatch = new MachineDispatch(hub);
  const env = new MachineExecutionEnv({ machineId: "machine", orgId: "org", chatId: "chat", workdir: "/tmp", timeoutMs: 1000, dispatch });
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
    expect(f.dispatch.resolveToolResult({ conn_id: "connection", org_id: "org" }, { call_id: f.frame().call_id, content: "late", is_error: false, meta: null, images: [] })).toBe(false);
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
    const pending = f.dispatch.dispatch({ machineId: "machine", orgId: "org", chatId: "chat", name: "execute", args: {}, workdir: "/tmp", timeoutMs: 10 });
    // The production timer is unref'd; keep the test invocation alive.
    const keepAlive = setTimeout(() => {}, 100);
    try {
      expect((await pending).is_error).toBe(true);
      expect(f.cancel).toHaveBeenCalledOnce();
    } finally { clearTimeout(keepAlive); }
  });

  it("carries cancellation over worker IPC before accepting any late response", async () => {
    const messages: unknown[] = [];
    const proxy = new IpcMachineDispatch(message => messages.push(message));
    const controller = new AbortController();
    const call = { machineId: "machine", orgId: "org", chatId: "chat", name: "execute", args: {}, workdir: "/tmp", timeoutMs: 1000 };
    const pending = proxy.dispatch(call, controller.signal);
    controller.abort();
    expect((await pending).is_error).toBe(true);
    expect(messages).toEqual([{ t: "dispatch", ref: 1, call }, { t: "dispatch_cancel", ref: 1 }]);
    expect(proxy.onResponse({ t: "result", ref: 1, ok: true, data: {} })).toBe(false);
  });
});
