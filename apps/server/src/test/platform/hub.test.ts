// Hub semantics: the live-slot rule, socket caps, ownership gates and
// dispatch correlation.

import { describe, it, expect } from "vitest";
import { LiveHub, MAX_SOCKETS_PER_USER, type LiveMember } from "../../hub/live.js";
import { SocketSink } from "../../hub/sink.js";
import { serializeServerMsg, parseClientMsg } from "../../hub/protocol.js";
import { TicketStore } from "../../hub/tickets.js";
import { uuidv7 } from "../../platform/time.js";

function member(userId?: string, orgId?: string, label: string | null = null): LiveMember {
  return { conn_id: uuidv7(), user_id: userId ?? uuidv7(), org_id: orgId ?? uuidv7(), sink: new SocketSink(), label };
}

function memberOf(m: LiveMember, label: string | null = null): LiveMember {
  return member(m.user_id, m.org_id, label);
}

describe("LiveHub — 0.5.25 live-slot rule", () => {
  it("rejects a foreign instance while the slot is live; the holder keeps it", async () => {
    const hub = new LiveHub();
    const old = member();
    const registration = await hub.registerMachineInstance(old, "m1", uuidv7(), false);
    expect("kind" in registration).toBe(false);
    expect(hub.machineOnline("m1")).toBe(true);

    const thief = memberOf(old, "Thief"); // same owner: the rejection is instance-based
    const rejected = await hub.registerMachineInstance(thief, "m1", uuidv7(), false);
    expect(rejected).toEqual({ kind: "displaced" });
    expect(hub.machineOnline("m1")).toBe(true);
    // The holder receives NOTHING — no Displaced notice goes out.
    expect(old.sink.queueDepth).toBe(0);
    expect(old.sink.isShutdown).toBe(false);
    expect(hub.machineHolder("m1")?.conn_id).toBe(old.conn_id);
  });

  it("rejects a stale resume from a non-current instance even after the old writer is gone", async () => {
    const hub = new LiveHub();
    const old = member();
    const newInstance = uuidv7();
    await hub.registerMachineInstance(old, "machine", uuidv7(), false);
    hub.unregisterMachine("machine", old.conn_id);
    const replacement = memberOf(old);
    await hub.registerMachineInstance(replacement, "machine", newInstance, false);
    // The dead instance tries to resume.
    const stale = await hub.registerMachineInstance(memberOf(old), "machine", uuidv7(), true);
    expect(stale).toEqual({ kind: "displaced" });
    expect(hub.machineHolder("machine")?.conn_id).toBe(replacement.conn_id);
  });

  it("a reconnect of the SAME instance replaces its own zombie slot (displacement + notice)", async () => {
    const hub = new LiveHub();
    const old = member();
    const instance = uuidv7();
    await hub.registerMachineInstance(old, "m1", instance, false);
    old.sink.send({ type: "hello" });
    const replacement = memberOf(old, "Desk");
    const re = await hub.registerMachineInstance(replacement, "m1", instance, false);
    expect("kind" in re).toBe(false);
    if ("kind" in re) throw new Error("unreachable");
    expect(re.displaced).toBe(true);
    expect(hub.machineOnline("m1")).toBe(true);
    expect(hub.machinesOfUser(old.user_id)).toEqual([["m1", "Desk"]]);
    // The old holder gets exactly one Displaced notice after its queued
    // output, then the shutdown latch fires.
    expect(old.sink.queueDepth).toBe(2); // hello + displaced
    const first = old.sink.take();
    expect(first && first.kind === "message" && first.msg.type).toBe("hello");
    const second = old.sink.take();
    expect(second && second.kind === "message" && second.msg.type).toBe("displaced");
    expect(old.sink.isShutdown).toBe(true);
    expect(hub.sinksOfUser(old.user_id).length).toBe(1);
  });

  it("refuses a foreign user's claim on a live slot", async () => {
    const hub = new LiveHub();
    const holder = member();
    await hub.registerMachineInstance(holder, "m1", uuidv7(), false);
    const foreign = member(); // different user
    const rejected = await hub.registerMachineInstance(foreign, "m1", uuidv7(), false);
    expect(rejected).toEqual({ kind: "foreign_owner" });
    expect(hub.machineHolder("m1")?.conn_id).toBe(holder.conn_id);
  });

  it("displaceMachine evicts without a replacement (re-pair adoption path)", async () => {
    const hub = new LiveHub();
    const old = member();
    await hub.registerMachineInstance(old, "old-id", uuidv7(), false);
    expect(hub.displaceMachine("old-id")).toBe(true);
    expect(hub.displaceMachine("old-id")).toBe(false);
    expect(hub.machineOnline("old-id")).toBe(false);
    expect(old.sink.isShutdown).toBe(true);
    expect(old.sink.queueDepth).toBe(1); // the Displaced notice
  });

  it("unregister_machine only removes the current holder's slot and drops its pending requests", async () => {
    const hub = new LiveHub();
    const holder = member();
    await hub.registerMachineInstance(holder, "m2", uuidv7(), false);
    // A pending request bound to this connection.
    const pending = hub.machineRequest("m2", holder.org_id, "fs_home", null, 100);
    // (No writer: the request sits queued; unregistering another conn_id
    // must not drop it.)
    hub.unregisterMachine("m2", uuidv7());
    hub.unregisterMachine("m2", holder.conn_id);
    expect(hub.machineOnline("m2")).toBe(false);
    await expect(pending).resolves.toEqual({ ok: false, error: { kind: "offline" } });
  });
});

describe("LiveHub — socket caps", () => {
  it("member cap is 32 and drop frees the slot", () => {
    const hub = new LiveHub();
    const userId = uuidv7();
    const members: LiveMember[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i += 1) {
      const m = member(userId);
      members.push(m);
      expect(hub.registerMember(m)).toBe(true);
    }
    expect(hub.registerMember(member(userId))).toBe(false);
    for (const m of members) hub.unregisterMember(userId, m.conn_id);
    expect(hub.registerMember(member(userId))).toBe(true);
  });

  it("re-registering the same conn_id never counts double", () => {
    const hub = new LiveHub();
    const userId = uuidv7();
    const m = member(userId);
    expect(hub.registerMember(m)).toBe(true);
    for (let i = 0; i < MAX_SOCKETS_PER_USER - 1; i += 1) {
      expect(hub.registerMember(m)).toBe(true); // idempotent, no double count
      expect(hub.registerMember(member(userId))).toBe(true);
    }
    expect(hub.registerMember(member(userId))).toBe(false);
  });

  it("machines count against the user socket cap; replacement keeps one budget slot", async () => {
    const hub = new LiveHub();
    const userId = uuidv7();
    const members: LiveMember[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i += 1) {
      const m = member(userId);
      members.push(m);
      expect(hub.registerMember(m)).toBe(true);
    }
    const machine = member(userId);
    expect(await hub.registerMachineInstance(machine, "full", uuidv7(), false)).toEqual({
      kind: "cap",
    });
    // One slot freed: the machine registers…
    const freed = members.pop()!;
    hub.unregisterMember(userId, freed.conn_id);
    const instance = uuidv7();
    const reg = await hub.registerMachineInstance(member(userId), "replaceable", instance, false);
    expect("kind" in reg).toBe(false);
    // …and its same-instance replacement keeps exactly one machine slot busy.
    const re = await hub.registerMachineInstance(member(userId), "replaceable", instance, false);
    expect("kind" in re).toBe(false);
    expect(hub.sinksOfUser(userId).length).toBe(MAX_SOCKETS_PER_USER);
  });
});

describe("LiveHub — label/bindable/list", () => {
  it("label falls back to the machine id; bindable by user or org", async () => {
    const hub = new LiveHub();
    const m = member();
    await hub.registerMachineInstance(m, "m1", uuidv7(), false);
    expect(hub.machineLabel("m1")).toBe("m1");
    expect(hub.machineLabel("m1")).not.toBeUndefined();
    expect(hub.machineBindable("m1", m.user_id, uuidv7())).toBe(true);
    expect(hub.machineBindable("m1", uuidv7(), m.org_id)).toBe(true);
    expect(hub.machineBindable("m1", uuidv7(), uuidv7())).toBe(false);
    expect(hub.machineLabel("missing")).toBeUndefined();
  });

  it("an empty label is stored as no label", async () => {
    const hub = new LiveHub();
    const m = member(undefined, undefined, "");
    await hub.registerMachineInstance(m, "m1", uuidv7(), false);
    expect(hub.machineLabel("m1")).toBe("m1");
  });

  it("machinesOfUser lists only that user's machines with labels", async () => {
    const hub = new LiveHub();
    const a = member();
    await hub.registerMachineInstance({ ...a, label: "Desk" }, "m1", uuidv7(), false);
    const b = member();
    await hub.registerMachineInstance({ ...b, label: "Laptop" }, "m2", uuidv7(), false);
    expect(hub.machinesOfUser(a.user_id)).toEqual([["m1", "Desk"]]);
    expect(hub.machinesOfUser(b.user_id)).toEqual([["m2", "Laptop"]]);
    expect(hub.sinksOfUser(a.user_id).length).toBe(1);
  });
});

describe("LiveHub — machine_request correlation", () => {
  it("correlates a MachineResponse from the exact dispatch connection and org", async () => {
    const hub = new LiveHub();
    const machine = member();
    await hub.registerMachineInstance(machine, "ctx-machine", uuidv7(), false);
    const pending = hub.machineRequest("ctx-machine", machine.org_id, "context.prepare_v1", {}, 2000);
    const queued = machine.sink.take();
    if (queued === undefined || queued.kind !== "message" || queued.msg.type !== "machine_request") {
      throw new Error("expected machine_request queued");
    }
    const requestId = queued.msg.request_id;
    // The wire bytes are the serde order.
    expect(serializeServerMsg(queued.msg)).toBe(
      `{"type":"machine_request","request_id":"${requestId}","op":"context.prepare_v1","payload":{}}`,
    );
    // Forged responses from other connections/orgs are ignored.
    hub.resolveMachineResponse({ ...machine, conn_id: uuidv7() }, requestId, true, { forged: true }, null);
    hub.resolveMachineResponse({ ...machine, org_id: uuidv7() }, requestId, true, { forged: true }, null);
    expect(await Promise.race([pending, new Promise((r) => setTimeout(() => r("still-pending"), 50))])).toBe(
      "still-pending",
    );
    hub.resolveMachineResponse(machine, requestId, true, { executor: true }, null);
    await expect(pending).resolves.toEqual({ ok: true, value: { executor: true } });
  });

  it("offline / timeout / rejected semantics", async () => {
    const hub = new LiveHub();
    expect(await hub.machineRequest("ghost", uuidv7(), "op", null, 100)).toEqual({
      ok: false,
      error: { kind: "offline" },
    });
    const machine = member();
    await hub.registerMachineInstance(machine, "m1", uuidv7(), false);
    // org mismatch → offline
    expect(await hub.machineRequest("m1", uuidv7(), "op", null, 100)).toEqual({
      ok: false,
      error: { kind: "offline" },
    });
    // timeout: the machine never answers (its queued request frame is
    // drained — no writer runs in this test)
    void hub.machineRequest("m1", machine.org_id, "op", null, 50);
    while (machine.sink.take() !== undefined);
    expect(await hub.machineRequest("m1", machine.org_id, "op", null, 50)).toEqual({
      ok: false,
      error: { kind: "timeout" },
    });
    while (machine.sink.take() !== undefined);
    // rejected: ok=false with the machine's error text
    const pending = hub.machineRequest("m1", machine.org_id, "op", null, 1000);
    const queued = machine.sink.take();
    const requestId = (queued as { msg: { request_id: string } }).msg.request_id;
    hub.resolveMachineResponse(machine, requestId, false, null, "no such folder");
    await expect(pending).resolves.toEqual({
      ok: false,
      error: { kind: "rejected", message: "no such folder" },
    });
    // ok=false without an error text falls back to the default message
    const pending2 = hub.machineRequest("m1", machine.org_id, "op", null, 1000);
    const q2 = machine.sink.take();
    hub.resolveMachineResponse(machine, (q2 as { msg: { request_id: string } }).msg.request_id, false, null, null);
    await expect(pending2).resolves.toEqual({
      ok: false,
      error: { kind: "rejected", message: "machine refused" },
    });
    // a late response after the timer fired finds no waiter
    hub.resolveMachineResponse(machine, requestId, true, { late: true }, null);
    expect(machine.sink.queueDepth).toBe(0);
  });

  it("pinned requests only fire while the pinned holder still holds the slot", async () => {
    const hub = new LiveHub();
    const holder = member();
    const instance = uuidv7();
    await hub.registerMachineInstance(holder, "m1", instance, false);
    // The holder is displaced by its own reconnect; the pinned reference is
    // now stale → offline, even though the machine is online.
    const replacement = memberOf(holder);
    await hub.registerMachineInstance(replacement, "m1", instance, false);
    expect(hub.machineOnline("m1")).toBe(true);
    expect(await hub.machineRequestPinned("m1", holder, "op", null, 100)).toEqual({
      ok: false,
      error: { kind: "offline" },
    });
    // A pinned request for the CURRENT holder goes out (queues the frame).
    void hub.machineRequestPinned("m1", replacement, "op", null, 100);
    const queued = replacement.sink.take();
    expect(queued !== undefined && queued.kind === "message").toBe(true);
  });
});

describe("wire codec", () => {
  it("client frames parse with serde defaults; garbage is discarded", () => {
    expect(parseClientMsg('{"type":"sync","chat_id":null}')).toEqual({ type: "sync", chat_id: null });
    expect(parseClientMsg('{"type":"sync"}')).toEqual({ type: "sync", chat_id: null });
    expect(parseClientMsg('{"type":"sync","chat_id":"nope"}')).toBeNull();
    expect(parseClientMsg('{"type":"read","chat_id":"00000000-0000-0000-0000-000000000000"}')).toEqual({
      type: "read",
      chat_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(parseClientMsg('{"type":"read"}')).toBeNull();
    expect(parseClientMsg('{"type":"read","chat_id":"nope"}')).toBeNull();
    expect(
      (
        parseClientMsg(
          '{"type":"tool_result","chat_id":"00000000-0000-0000-0000-000000000000","call_id":"old","content":"text","is_error":false,"meta":null}',
        ) as { images: string[] }
      ).images,
    ).toEqual([]);
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg('{"type":"unknown_variant"}')).toBeNull();
  });

  it("server frames serialize in serde declaration order", () => {
    expect(serializeServerMsg({ type: "hello" })).toBe('{"type":"hello"}');
    expect(serializeServerMsg({ type: "displaced" })).toBe('{"type":"displaced"}');
    expect(serializeServerMsg({ type: "auth_required" })).toBe('{"type":"auth_required"}');
    expect(
      serializeServerMsg({
        type: "tool_dispatch",
        chat_id: "00000000-0000-0000-0000-000000000000",
        call_id: "c1",
        name: "execute",
        arguments: "{}",
      }),
    ).toBe(
      '{"type":"tool_dispatch","chat_id":"00000000-0000-0000-0000-000000000000","call_id":"c1","name":"execute","arguments":"{}"}',
    );
    expect(
      serializeServerMsg({
        type: "tool_dispatch",
        chat_id: "00000000-0000-0000-0000-000000000000",
        call_id: "c1",
        name: "execute",
        arguments: "{}",
        workdir: "/w",
      }),
    ).toBe(
      '{"type":"tool_dispatch","chat_id":"00000000-0000-0000-0000-000000000000","call_id":"c1","name":"execute","arguments":"{}","workdir":"/w"}',
    );
    expect(serializeServerMsg({ type: "error", message: "x" })).toBe('{"type":"error","message":"x"}');
    expect(serializeServerMsg({ type: "thread_list", chats: [] })).toBe('{"type":"thread_list","chats":[]}');
    expect(
      serializeServerMsg({
        type: "subagent_tree",
        chat_id: "00000000-0000-0000-0000-000000000000",
        nodes: [
          {
            thread_id: "t1",
            chat_id: "00000000-0000-0000-0000-000000000000",
            parent_thread_id: null,
            agent_name: "researcher",
            title: "Patents",
            depth: 0,
            status: null,
          },
        ],
      }),
    ).toBe(
      '{"type":"subagent_tree","chat_id":"00000000-0000-0000-0000-000000000000","nodes":[{"thread_id":"t1","chat_id":"00000000-0000-0000-0000-000000000000","parent_thread_id":null,"agent_name":"researcher","title":"Patents","depth":0,"status":null}]}',
    );
  });
});

describe("TicketStore", () => {
  it("mints gst_ + uuid-v7-simple, single-use", () => {
    const store = new TicketStore();
    const identity = { user: { id: uuidv7() } as never, session_hash: "h", expires_at: new Date(Date.now() + 60_000) };
    const ticket = store.mint(identity);
    expect(ticket.startsWith("gst_")).toBe(true);
    expect(ticket).toMatch(/^gst_[0-9a-f]{32}$/);
    expect(store.consume(ticket)?.session_hash).toBe("h");
    expect(store.consume(ticket)).toBeNull(); // single-use
  });

  it("a ticket older than the TTL is not consumed even if never used", () => {
    const store = new TicketStore();
    const identity = { user: { id: uuidv7() } as never, session_hash: "h", expires_at: new Date(Date.now() + 60_000) };
    const ticket = store.mint(identity);
    // Age the stored entry past the TTL (private state reached for the test).
    const stored = (store as unknown as { tickets: Map<string, { at: number }> }).tickets.get(ticket);
    if (stored) stored.at = Date.now() - 31_000;
    expect(store.consume(ticket)).toBeNull();
  });
});
