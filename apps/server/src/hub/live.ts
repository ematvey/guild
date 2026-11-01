// Connection hub for browser member sockets and machine singleton sockets.
// Liveness is a socket held in the hub. Everything runs on the Node event
// loop, so registry updates never interleave.

import { uuidv7 } from "../platform/time.js";
import { SocketSink } from "./sink.js";
import type { MachineRequestError } from "./index.js";
import type { WsServerMsg } from "./protocol.js";

export const MAX_SOCKETS_PER_USER = 32;

export type MachineRejected = { kind: "cap" } | { kind: "displaced" } | { kind: "foreign_owner" };

export interface MachineRegistration {
  displaced: boolean;
  /** Notified when this registration loses its slot (a newer same-instance
   *  connect, or a re-pair adoption re-keying the row away). */
  signalShutdown(): void;
}

/** One connected socket: the outbound queue is the sink the writer drains. */
export interface LiveMember {
  conn_id: string;
  user_id: string;
  org_id: string;
  sink: SocketSink;
  label: string | null;
}

interface MachineSlot {
  holder: LiveMember;
  shutdown: () => void;
}

export type MachineRequestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: MachineRequestError };

interface PendingMachineRequest {
  connection_id: string;
  org_id: string;
  /** Exactly-once settlement: payload (ok response), rejected (the machine's
   *  refusal), dropped (the connection died mid-flight → offline). */
  settle: (r: { settled: "payload" | "rejected" | "dropped"; payload?: unknown; error?: string | null }) => void;
}

export class LiveHub {
  private machines = new Map<string, MachineSlot>();
  /** Last instance claim survives disconnect, so a stale reconnect cannot
   *  reclaim the slot after losing its terminal notice (0.5.25). */
  private owners = new Map<string, string>();
  private members = new Map<string, Map<string, LiveMember>>();
  private machineRequests = new Map<string, PendingMachineRequest>();
  /** The dispatch lane's disconnect hook (pending machine tools settle as
   *  unknown-outcome when their connection dies). */
  onMachineDisconnected?: (machineId: string, connId: string) => void;
  /** Machine slot presence flips (claimed, released, displaced): the feed
   *  forwards each one to the owner's member sockets. */
  onMachineStatus?: (machineId: string, userId: string, orgId: string, online: boolean) => void;

  /** Registers a browser socket, rejecting a new connection over the limit. */
  registerMember(m: LiveMember): boolean {
    const perUser = this.members.get(m.user_id);
    const alreadyRegistered = perUser?.has(m.conn_id) ?? false;
    if (!alreadyRegistered && this.socketCount(m.user_id) >= MAX_SOCKETS_PER_USER) {
      return false;
    }
    if (!this.members.has(m.user_id)) this.members.set(m.user_id, new Map());
    this.members.get(m.user_id)!.set(m.conn_id, m);
    return true;
  }

  private socketCount(userId: string): number {
    const members = this.members.get(userId)?.size ?? 0;
    let machines = 0;
    for (const slot of this.machines.values()) {
      if (slot.holder.user_id === userId) machines += 1;
    }
    return members + machines;
  }

  /** Registers a machine socket with instance tracking. The 0.5.25 live-slot
   *  rule: a LIVE machine slot is HELD, not displaced. A second instance
   *  connecting while one holds the slot is a duplicate daemon or an
   *  identity thief — rejected instead of displacing a healthy link (the
   *  displaced link never learns it lost the slot: its leftover server conn
   *  keeps exchanging heartbeats, so the daemon sits "connected" while the
   *  machine shows offline until restart, 2026-09-28/29). A
   *  reconnect of the SAME instance replaces its own zombie slot — this
   *  heals honest blips and the observed thief pattern (fresh instance).
   *  `resume=true` from a stale (non-current) instance is likewise rejected. */
  async registerMachineInstance(
    m: LiveMember,
    machineId: string,
    instance: string,
    resume: boolean,
  ): Promise<MachineRegistration | MachineRejected> {
    const old = this.machines.get(machineId)?.holder ?? null;
    if (resume && this.owners.get(machineId) !== undefined && this.owners.get(machineId) !== instance) {
      return { kind: "displaced" };
    }
    if (old !== null && old.user_id !== m.user_id) {
      // Ownership gate: the current holder is a different user, so the claim
      // never displaces it (a machine slot belongs to its user — newest-wins
      // applies within one user only).
      return { kind: "foreign_owner" };
    }
    if (
      old !== null &&
      this.owners.get(machineId) !== undefined &&
      this.owners.get(machineId) !== instance
    ) {
      // The 0.5.25 live-slot rule (see above).
      return { kind: "displaced" };
    }
    const replacingExistingMachine = old !== null && old.user_id === m.user_id;
    const socketCount = this.socketCount(m.user_id);
    const socketCountAfterReplace = Math.max(0, socketCount - (replacingExistingMachine ? 1 : 0));
    if (socketCountAfterReplace >= MAX_SOCKETS_PER_USER) {
      return { kind: "cap" };
    }

    // This registration's own shutdown signal: fires when IT loses the slot
    // (the same-instance reconnect below or a later re-pair adoption).
    let shutdownFired = false;
    const shutdown = (): void => {
      if (!shutdownFired) {
        shutdownFired = true;
        m.sink.signalShutdown();
      }
    };
    const oldSlot = this.machines.get(machineId);
    this.owners.set(machineId, instance);
    this.machines.set(machineId, { holder: m, shutdown });
    // Presence flips only on the first claim: a replacement keeps the slot
    // online for the whole swap.
    if (oldSlot === undefined) this.onMachineStatus?.(machineId, m.user_id, m.org_id, true);

    if (oldSlot !== undefined) {
      oldSlot.holder.sink.displace();
      oldSlot.shutdown();
      return { displaced: true, signalShutdown: shutdown };
    }
    return { displaced: false, signalShutdown: shutdown };
  }

  unregisterMember(userId: string, connId: string): void {
    const perUser = this.members.get(userId);
    if (!perUser) return;
    perUser.delete(connId);
    if (perUser.size === 0) this.members.delete(userId);
  }

  unregisterMachine(machineId: string, connId: string): void {
    for (const [requestId, pending] of this.machineRequests) {
      if (pending.connection_id === connId) {
        this.machineRequests.delete(requestId);
        // The responder dropped without a send: the machine disconnected
        // while its requests were in flight.
        pending.settle({ settled: "dropped" });
      }
    }
    const holder = this.machines.get(machineId)?.holder ?? null;
    const isCurrent = holder !== null && holder.conn_id === connId;
    if (isCurrent) {
      this.machines.delete(machineId);
      this.onMachineStatus?.(machineId, holder.user_id, holder.org_id, false);
    }
    this.onMachineDisconnected?.(machineId, connId);
  }

  /** Sends one tool-dispatch frame to the machine's executor socket. False
   *  when there is no live slot for the org or the sink refused (offline). */
  sendMachineToolDispatch(machineId: string, orgId: string, msg: WsServerMsg & { type: "tool_dispatch" }): boolean {
    const holder = this.machineHolder(machineId);
    if (holder === null || holder.org_id !== orgId) return false;
    return holder.sink.send(msg);
  }

  /** Cancellation belongs to the connection that accepted the call. */
  sendMachineToolCancel(machineId: string, orgId: string, connectionId: string, callId: string): boolean {
    const holder = this.machineHolder(machineId);
    if (!holder || holder.org_id !== orgId || holder.conn_id !== connectionId) return false;
    return holder.sink.send({ type: "tool_cancel", call_id: callId });
  }

  /** Displaces a machine's live socket without a replacement: registry
   *  adoption re-keyed the row away from this id, so the old registration no
   *  longer has a registry identity to hold. */
  displaceMachine(machineId: string): boolean {
    const slot = this.machines.get(machineId);
    if (!slot) return false;
    this.machines.delete(machineId);
    this.onMachineStatus?.(machineId, slot.holder.user_id, slot.holder.org_id, false);
    slot.holder.sink.displace();
    slot.shutdown();
    return true;
  }

  machineHolder(machineId: string): LiveMember | null {
    return this.machines.get(machineId)?.holder ?? null;
  }

  /** Sends a control-plane request to the machine's executor socket and
   *  awaits its `MachineResponse`. Offline/send/timeout are clean errors;
   *  the machine's own refusal arrives as `rejected`. */
  async machineRequest(
    machineId: string,
    orgId: string,
    op: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<MachineRequestResult> {
    const holder = this.machineHolder(machineId);
    if (holder === null || holder.org_id !== orgId) {
      return { ok: false, error: { kind: "offline" } };
    }
    return this.sendMachineRequest(holder, orgId, op, payload, timeoutMs);
  }

  /** `machine_request` pinned to an already-validated socket holder: the
   *  request goes out only while `holder` still holds the machine slot (same
   *  connection); a re-pair or reclaim since validation is `offline`. */
  async machineRequestPinned(
    machineId: string,
    holder: LiveMember,
    op: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<MachineRequestResult> {
    const current = this.machineHolder(machineId);
    if (current === null || current.conn_id !== holder.conn_id || current.org_id !== holder.org_id) {
      return { ok: false, error: { kind: "offline" } };
    }
    return this.sendMachineRequest(current, holder.org_id, op, payload, timeoutMs);
  }

  private async sendMachineRequest(
    holder: LiveMember,
    orgId: string,
    op: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<MachineRequestResult> {
    const requestId = uuidv7();
    let settle: PendingMachineRequest["settle"];
    const done = new Promise<{ settled: "payload" | "rejected" | "dropped"; payload?: unknown; error?: string | null }>(
      (resolve) => {
        settle = resolve;
      },
    );
    this.machineRequests.set(requestId, {
      connection_id: holder.conn_id,
      org_id: orgId,
      settle: settle!,
    });

    // The pending entry is removed on every exit path.
    try {
      const sent = holder.sink.send({
        type: "machine_request",
        request_id: requestId,
        op,
        payload,
      });
      if (!sent) {
        return { ok: false, error: { kind: "offline" } };
      }
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        done,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
          // Keep the process from being held open by a pure timer race.
          timer.unref?.();
        }),
      ]);
      if (outcome === "timeout") {
        // Elapsed timer: drop the pending entry so the late response (if the
        // machine still answers) finds no waiter.
        this.machineRequests.delete(requestId);
        return { ok: false, error: { kind: "timeout" } };
      }
      if (outcome.settled === "payload") return { ok: true, value: outcome.payload ?? null };
      if (outcome.settled === "dropped") {
        // The responder vanished without a send: the machine disconnected
        // while the request was in flight.
        return { ok: false, error: { kind: "offline" } };
      }
      return {
        ok: false,
        error: { kind: "rejected", message: outcome.error ?? "machine refused" },
      };
    } finally {
      this.machineRequests.delete(requestId);
    }
  }

  /** Routes a machine's `MachineResponse` to its waiter (from the socket
   *  inbound path). Unknown request ids are dropped silently — a request
   *  whose timer already fired. */
  resolveMachineResponse(
    member: LiveMember,
    requestId: string,
    ok: boolean,
    payload: unknown,
    error: string | null,
  ): void {
    const pending = this.machineRequests.get(requestId);
    if (!pending) return;
    if (pending.connection_id !== member.conn_id || pending.org_id !== member.org_id) return;
    this.machineRequests.delete(requestId);
    pending.settle(
      ok
        ? { settled: "payload", payload: payload ?? null }
        : { settled: "rejected", error },
    );
  }

  machineOnline(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  /** Returns the connection label, falling back to the machine id. */
  machineLabel(machineId: string): string | undefined {
    const slot = this.machines.get(machineId);
    if (!slot) return undefined;
    return slot.holder.label !== null && slot.holder.label !== "" ? slot.holder.label : machineId;
  }

  /** Returns whether a live machine belongs to the user or organization. */
  machineBindable(machineId: string, userId: string, orgId: string): boolean {
    const slot = this.machines.get(machineId);
    return slot !== undefined && (slot.holder.user_id === userId || slot.holder.org_id === orgId);
  }

  /** Returns live `[machine_id, label]` entries for one user. */
  machinesOfUser(userId: string): [string, string][] {
    const out: [string, string][] = [];
    for (const [id, slot] of this.machines) {
      if (slot.holder.user_id !== userId) continue;
      out.push([
        id,
        slot.holder.label !== null && slot.holder.label !== "" ? slot.holder.label : id,
      ]);
    }
    return out;
  }

  /** Returns browser sockets and machine sockets of one organization —
   *  the org-event fan-out. */
  sinksOfOrg(orgId: string): SocketSink[] {
    const sinks: SocketSink[] = [];
    for (const perUser of this.members.values()) {
      for (const member of perUser.values()) {
        if (member.org_id === orgId) sinks.push(member.sink);
      }
    }
    for (const slot of this.machines.values()) {
      if (slot.holder.org_id === orgId) sinks.push(slot.holder.sink);
    }
    return sinks;
  }

  /** Returns the users of one organization with a browser socket open: the
   *  recipients the agent and skill frames are scoped among. */
  memberUsersOfOrg(orgId: string): string[] {
    const users: string[] = [];
    for (const [userId, perUser] of this.members) {
      for (const member of perUser.values()) {
        if (member.org_id === orgId) {
          users.push(userId);
          break;
        }
      }
    }
    return users;
  }

  /** Returns browser sockets of one user (no machine sockets: presence
   *  frames are for the UI, not the executor). */
  memberSinksOfUser(userId: string): SocketSink[] {
    const sinks: SocketSink[] = [];
    const perUser = this.members.get(userId);
    if (perUser) for (const member of perUser.values()) sinks.push(member.sink);
    return sinks;
  }

  /** Returns browser sockets and machine sockets for one user. */
  sinksOfUser(userId: string): SocketSink[] {
    const sinks: SocketSink[] = [];
    const perUser = this.members.get(userId);
    if (perUser) for (const member of perUser.values()) sinks.push(member.sink);
    for (const slot of this.machines.values()) {
      if (slot.holder.user_id === userId) sinks.push(slot.holder.sink);
    }
    return sinks;
  }
}
