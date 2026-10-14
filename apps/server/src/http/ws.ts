// Per-client WebSocket endpoint: single-use
// ticket auth, one upgrade route, per-user socket caps live in the hub.
// Browsers cannot send headers on upgrade, and long-lived tokens in a query
// string leak into access logs — hence the ticket hop over the normal
// authenticated HTTP session.
//
// Frames are byte-compatible with the Rust server (shipped daemons never
// update): serialization lives in hub/protocol.ts.
//
// Deliberately NOT here (other lanes' territory, wired via the ctx seams):
// the live feed forwarder + state-sync capture (chats/M3), the machine-tool
// ExecutionEnv (harness/M4/M5-dispatch), the Restate funnel's
// reconcile_machine_tools (M5-dispatch).

import type { FastifyInstance } from "fastify";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatsCtx, IdentityCtx } from "../platform/contexts.js";
import type { PlatformPool } from "../platform/db.js";
import { ApiError } from "../platform/errors.js";
import { requireUser } from "../platform/http/error.js";
import type { UserRow } from "../platform/store/identity.js";
import { uuidv7 } from "../platform/time.js";
import { LiveHub, type LiveMember } from "../hub/live.js";
import { SocketSink } from "../hub/sink.js";
import { parseClientMsg, serializeServerMsg, type WsServerMsg } from "../hub/protocol.js";
import { threadListSnapshot } from "../hub/feed.js";
import { TicketStore, type TicketIdentity } from "../hub/tickets.js";
void TicketStore;

// A socket that cannot flush its terminal notice within this deadline is
// treated as dead. No socket write may delay eviction beyond this bound.
export const TERMINAL_WRITE_TIMEOUT_MS = 1_000;
// Registry last_seen refreshes at most this often per machine socket; the
// ping heartbeat itself runs faster.
export const LAST_SEEN_REFRESH_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const SESSION_WATCH_INTERVAL_MS = 5_000;
const PONG_POLL_MS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MachineConnectMeta {
  label: string | null;
  fingerprint: string | null;
  os: string | null;
  os_version: string | null;
  app_version: string | null;
}

export interface UpgradeQuery {
  ticket: string;
  client_id: string | null;
  machine_id: string | null;
  machine_name: string | null;
  machine_fingerprint: string | null;
  machine_os: string | null;
  machine_os_version: string | null;
  machine_app_version: string | null;
  instance_id: string | null;
  resume: boolean;
}

/** Desktop-supplied registry metadata from the upgrade query; the store
 *  turns empty values into NULL. */
function metaFromQuery(q: UpgradeQuery): MachineConnectMeta {
  return {
    label: q.machine_name,
    fingerprint: q.machine_fingerprint,
    os: q.machine_os,
    os_version: q.machine_os_version,
    app_version: q.machine_app_version,
  };
}

/** 16 raw bytes of a uuid v7 (the heartbeat challenge — Rust
 *  `Uuid::now_v7().as_bytes()`). */
function uuidv7Bytes(): Buffer {
  return Buffer.from(uuidv7().replaceAll("-", ""), "hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// HTTP side

export function registerWsRoutes(app: FastifyInstance, chats: ChatsCtx, ctx: IdentityCtx): void {
  app.post("/api/v1/ws/ticket", async (req, reply) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw ApiError.unauthorized("missing bearer");
    }
    const token = header.slice("Bearer ".length);
    // The user row comes from the normal session validation; the grant adds
    // the hash + expiry the ticket identity carries into the upgrade.
    const user = await requireUser(ctx, req);
    const [sessionHash, expiresAt] = await ctx.identity.sessionGrant(token);
    const ticket = chats.wsTickets.mint({ user, session_hash: sessionHash, expires_at: expiresAt });
    return reply.status(200).send({ ticket });
  });
}

// ---------------------------------------------------------------------------
// Upgrade side

/** Attaches the hub's upgrade listener to the HTTP server. This is the ONLY
 *  'upgrade' listener after the flip: the proxy's `websocket: true` handling
 *  is removed in app.ts, because two listeners double-assign the socket
 *  (ERR_HTTP_SOCKET_ASSIGNED, the M0 trap note). Rollback = re-enable the
 *  proxy flag and delete this attach call. */
export function attachWsUpgrade(server: Server, chats: ChatsCtx, auth: IdentityCtx, pool: PlatformPool): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let query: UpgradeQuery;
    try {
      query = parseUpgradeQuery(req);
    } catch (error) {
      rejectUpgrade(socket, 400, error instanceof Error ? error.message : "bad request");
      return;
    }
    const identity = chats.wsTickets.consume(query.ticket);
    if (identity === null) {
      rejectUpgrade(socket, 401, "invalid or expired ticket");
      return;
    }
    void sessionValid(auth, identity.session_hash).then((valid) => {
      if (!valid) {
        rejectUpgrade(socket, 401, "session expired or revoked");
        return;
      }
      if (query.machine_id !== null && query.instance_id === null) {
        rejectUpgrade(socket, 400, "machine connections require instance_id");
        return;
      }
      const peerIp = ipOf(req);
      wss.handleUpgrade(req, socket, head, (ws) => {
        void driveSocket(chats, auth, pool, identity, query, peerIp, ws);
      });
    });
  });
}

function ipOf(req: IncomingMessage): string | null {
  const address = req.socket.remoteAddress ?? null;
  return address !== null && address !== "" ? address : null;
}

/** Axum-shaped upgrade rejections: the JSON error envelope over a real HTTP
 *  response, then the socket dies. */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: { code: status === 401 ? "unauthorized" : "bad_request", message } });
  const reason = status === 401 ? "Unauthorized" : "Bad Request";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

/** `?ticket=<single-use>&client_id=<stable browser id>&machine_id=<opt>…`.
 *  `client_id` identifies the browser across tabs (member identity);
 *  `machine_id` (desktop only) claims the machine's singleton slot. The
 *  `machine_*` params carry registry metadata. */
export function parseUpgradeQuery(req: IncomingMessage): UpgradeQuery {
  const url = new URL(req.url ?? "/", "http://localhost");
  const get = (name: string): string | null => {
    const value = url.searchParams.get(name);
    return value !== null && value !== "" ? value : null;
  };
  const ticket = url.searchParams.get("ticket");
  if (ticket === null || ticket === "") throw new Error("missing query parameter: ticket");
  const machineId = get("machine_id");
  const instanceId = get("instance_id");
  if (instanceId !== null && !UUID_RE.test(instanceId)) {
    throw new Error("invalid instance_id");
  }
  const resumeRaw = url.searchParams.get("resume");
  let resume = false;
  if (resumeRaw !== null) {
    if (resumeRaw === "true") resume = true;
    else if (resumeRaw !== "false") throw new Error("invalid resume value");
  }
  return {
    ticket,
    client_id: get("client_id"),
    machine_id: machineId,
    machine_name: get("machine_name"),
    machine_fingerprint: get("machine_fingerprint"),
    machine_os: get("machine_os"),
    machine_os_version: get("machine_os_version"),
    machine_app_version: get("machine_app_version"),
    instance_id: instanceId,
    resume,
  };
}

// ---------------------------------------------------------------------------
// Socket lifecycle

type SocketExitReason = "displaced" | "reader" | "writer" | "heartbeat" | "session";

/** Each challenge has a unique payload. Unrelated traffic cannot renew
 *  liveness. (Rust `session_valid` — 2s timeout on the DB check.) */
async function sessionValid(auth: IdentityCtx, hash: string): Promise<boolean> {
  try {
    const result = await Promise.race([
      auth.identity.sessionExpiry(hash),
      new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 2_000);
        timer.unref?.();
      }),
    ]);
    return result !== "timeout";
  } catch {
    return false;
  }
}

/** Connect-path ownership gate: a registered machine's hub slot is claimed
 *  only by its owning user (the registry row is the durable identity; the
 *  hub enforces the same rule against a live slot). An unregistered id is a
 *  new pairing and passes. Registry unavailability fails closed. */
async function machineSlotOwned(chats: ChatsCtx, user: UserRow, machineId: string): Promise<boolean> {
  try {
    const owner = await chats.machines.ownerOf(machineId);
    return owner === null || owner[0] === user.id;
  } catch (error) {
    chats.wsLog?.(`machine ownership gate failed for ${machineId}: ${errorMessage(error)}`);
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Connect-time registration in the durable machine registry: adopts a
 *  fingerprint-matched row (re-pair) or inserts a new one. Registry failure
 *  never blocks the socket — the hub slot remains the liveness truth. */
async function registerMachineRecord(
  chats: ChatsCtx,
  user: UserRow,
  machineId: string,
  meta: MachineConnectMeta,
  peerIp: string | null,
  clientId: string,
  hub: LiveHub,
): Promise<void> {
  chats.wsLog?.(
    `ws machine connect machine_id=${machineId} app_version=${meta.app_version ?? ""} label=${meta.label ?? ""} fingerprint=${meta.fingerprint ?? ""} client_id=${clientId}`,
  );
  try {
    const outcome = await chats.machines.upsertConnected(
      user.org_id,
      user.id,
      machineId,
      meta.label,
      meta.fingerprint,
      meta.os,
      meta.os_version,
      meta.app_version,
      peerIp,
    );
    if (outcome.adopted_from !== null) {
      // The re-key left any live registration under the old id without a
      // registry identity: displace it per the singleton rule.
      const displaced = hub.displaceMachine(outcome.adopted_from);
      chats.wsLog?.(
        `machine re-pair adoption machine_id=${machineId} old_machine_id=${outcome.adopted_from} displaced=${displaced}`,
      );
    }
  } catch (error) {
    chats.wsLog?.(`machine registry upsert failed for ${machineId}: ${errorMessage(error)}`);
  }
}

/** Holds live feed messages while one or more state-sync brackets are open.
 *  (Rust SocketGate.) */
class SocketGate {
  private syncDepth = 0;
  private deferred: WsServerMsg[] = [];

  private static isLive(message: WsServerMsg): boolean {
    return (
      message.type === "live_frame" ||
      message.type === "chat_status" ||
      message.type === "org_event" ||
      message.type === "error"
    );
  }

  push(output: { kind: string; msg?: WsServerMsg }): WsServerMsg[] {
    if (output.kind === "sync_start") {
      this.syncDepth += 1;
      return [];
    }
    const message = output.msg!;
    if (this.syncDepth > 0 && SocketGate.isLive(message)) {
      this.deferred.push(message);
      return [];
    }
    const out = [message];
    if (message.type === "sync_done") {
      this.syncDepth = Math.max(0, this.syncDepth - 1);
      if (this.syncDepth === 0) out.push(...this.deferred.splice(0));
    }
    return out;
  }
}

/** The socket supervisor (Rust drive_socket): registration gates, then
 *  reader + writer + heartbeat + session-watch all racing; the first to end
 *  tears the socket down. */
async function driveSocket(
  chats: ChatsCtx,
  auth: IdentityCtx,
  pool: PlatformPool,
  identity: TicketIdentity,
  query: UpgradeQuery,
  peerIp: string | null,
  socket: WebSocket,
): Promise<void> {
  const { user, session_hash: sessionHash, expires_at: expiresAt } = identity;
  const hub = chats.hub;
  const sink = new SocketSink();
  const connId = uuidv7();
  const meta = metaFromQuery(query);
  const machineId = query.machine_id;
  const member: LiveMember = {
    conn_id: connId,
    user_id: user.id,
    org_id: user.org_id,
    sink,
    label: meta.label,
  };

  let machineRegistered = false;
  if (machineId !== null) {
    // Ownership gate before any hub slot is claimed: a registered machine
    // connects only as its owning user (the registry row is the durable
    // identity; the hub enforces the same rule for a live slot). No row yet
    // = a new pairing, allowed.
    if (!(await machineSlotOwned(chats, user, machineId))) {
      await sendTerminal(socket, { type: "error", message: "machine belongs to another user" });
      return;
    }
    const registration = await hub.registerMachineInstance(
      member,
      machineId,
      query.instance_id!,
      query.resume,
    );
    if ("kind" in registration) {
      if (registration.kind === "foreign_owner") {
        await sendTerminal(socket, { type: "error", message: "machine belongs to another user" });
      } else if (registration.kind === "displaced") {
        chats.wsLog?.(
          `ws machine connect rejected: slot held by a live link machine_id=${machineId} instance_id=${query.instance_id}`,
        );
        await sendTerminal(socket, { type: "displaced" });
      } else {
        await sendTerminal(socket, { type: "error", message: "too many connections" });
      }
      return;
    }
    machineRegistered = true;
    await registerMachineRecord(chats, user, machineId, meta, peerIp, query.client_id ?? "", hub);
    // Skills convergence at connect is the machine's own HTTP pull
    // (`GET /api/v1/skills/sync-payload`, Rust machine_link.rs) — no
    // sync frame rides the machine-connect stream (the WS golden replay
    // pins it byte-exactly); change-trigger pushes remain server-side.
  } else {
    if (!hub.registerMember(member)) {
      await sendTerminal(socket, { type: "error", message: "too many connections" });
      return;
    }
  }

  // --- teardown plumbing ---------------------------------------------------
  let finished = false;
  const unregister = (): void => {
    if (machineId !== null) {
      if (machineRegistered) hub.unregisterMachine(machineId, connId);
    } else {
      hub.unregisterMember(user.id, connId);
    }
  };
  const finish = (reason: SocketExitReason): void => {
    if (finished) return;
    finished = true;
    chats.wsLog?.(
      `ws link ended conn_id=${connId} machine_id=${machineId ?? ""} instance_id=${query.instance_id ?? ""} reason=${reason}`,
    );
    unregister();
    sink.close();
    try {
      socket.close();
    } catch {
      // already dead
    }
  };

  // --- writer (the single drainer of the sink) ------------------------------
  const writerLoop = (async (): Promise<"notice" | "close"> => {
    const gate = new SocketGate();
    let wroteDisplaced = false;
    while (true) {
      await sink.waitForWork();

      if (sink.isDead) return "close";
      if (sink.isOverloaded) {
        // No notice: the queue cannot flush, so the socket just dies.
        return "close";
      }
      if (sink.isShutdown) {
        await terminalNotice(socket, { type: "displaced" }, () => wroteDisplaced);
        return "notice";
      }
      if (sink.isAuthRequired) {
        await terminalNotice(socket, { type: "auth_required" }, () => false);
        return "notice";
      }
      const output = sink.take();
      if (output === undefined) continue;
      if (output.kind === "ping" || output.kind === "pong") {
        if (!(await timedSend(socket, output))) return "close";
        sink.ackWritten(1);
        continue;
      }
      if (output.kind === "sync_start") {
        sink.ackSyncStart();
        continue;
      }
      const displacedInQueue = output.msg !== undefined && output.msg.type === "displaced";
      for (const message of gate.push(output)) {
        if (message.type === "displaced") wroteDisplaced = true;
        if (!(await timedSend(socket, { kind: "message", msg: message }))) return "close";
        sink.ackWritten(1);
      }
      if (displacedInQueue && !wroteDisplaced) {
        // Unreachable when the gate wrote it (wroteDisplaced set), but kept
        // as the invariant: the displacement notice always ends the socket.
        wroteDisplaced = true;
      }
      if (displacedInQueue) return "notice";
    }
  })();
  void writerLoop.then(() => finish("writer"));

  // --- client-message processing (Rust client_task, serialized) -------------
  let processing: Promise<void> = Promise.resolve();
  const processClient = (message: NonNullable<ReturnType<typeof parseClientMsg>>): void => {
    processing = processing.then(async () => {
      if (finished) return;
      // Per-message revalidation (Rust client_task): an expired or revoked
      // session, a deleted user, or an org switch ends processing.
      if (!(await sessionValid(auth, sessionHash))) return;
      let current: UserRow;
      try {
        current = await auth.identity.getUser(user.id);
      } catch {
        return;
      }
      if (current.org_id !== user.org_id) return;

      if (message.type === "sync") {
        if (message.chat_id !== null) await runSyncStarted(chats, current, message.chat_id, sink);
        return;
      }
      if (message.type === "machine_response") {
        hub.resolveMachineResponse(
          member,
          message.request_id,
          message.ok,
          message.payload ?? null,
          message.error ?? null,
        );
        return;
      }
      if (message.type === "tool_result") {
        // The owns_pending_tool + complete_tool path is the dispatch lane's;
        // without the handler wired, results are dropped (Rust's behavior
        // when this connection owns no pending call).
        await chats.wsToolResult?.({ member, user: current, frame: message });
      }
    });
  };

  // --- reader (event-driven) -------------------------------------------------
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (finished || isBinary) return;
    const message = parseClientMsg(data.toString("utf8"));
    if (message === null) return; // unknown envelopes are discarded, not fatal
    if (message.type === "sync" && message.chat_id !== null) {
      if (!sink.startSync()) {
        finish("reader");
        return;
      }
    }
    processClient(message);
  });
  // Client pings: the ws library auto-pongs with the same payload (the Rust
  // reader queues the Pong through the sink; the wire result is identical).
  socket.on("pong", (data: Buffer) => {
    sink.notifyPong(data);
  });
  socket.on("close", (code, reason) => { chats.wsLog?.(`ws close frame code=${code} reason=${String(reason)}`); finish("reader"); });
  socket.on("error", (err) => { chats.wsLog?.(`ws socket error: ${err.message}`); finish("reader"); });

  // --- connect bootstrap (Rust reader prologue) ------------------------------
  sink.send({ type: "hello" });
  if (machineId !== null) {
    // reconcile_machine_tools (the uncertain-execution sweep) is the
    // dispatch lane's; a no-op until wired.
    await chats.wsMachineReconcile?.(machineId, connId);
  }
  try {
    const list = await threadListSnapshot(chats, pool, user);
    sink.send({ type: "thread_list", chats: list });
  } catch (error) {

    sink.send({
      type: "error",
      message: error instanceof ApiError ? error.message : "internal server error",
    });
  }

  // --- heartbeat (Rust heartbeat task) ---------------------------------------
  const heartbeatLoop = (async (): Promise<void> => {
    let lastRefresh = -1;
    while (!finished) {
      const challenge = uuidv7Bytes();
      if (!sink.ping(challenge)) return;
      const matched = await pongMatch(sink, challenge);
      if (!matched || finished) return;
      if (machineId !== null && Date.now() - lastRefresh >= LAST_SEEN_REFRESH_MS) {
        try {
          await chats.machines.lastSeen(machineId);
        } catch (error) {
          chats.wsLog?.(`last_seen refresh failed for ${machineId}: ${errorMessage(error)}`);
        }
        lastRefresh = Date.now();
      }
      await sleep(HEARTBEAT_INTERVAL_MS);
    }
  })();
  void heartbeatLoop.then(() => finish("heartbeat"));

  // --- session watch (Rust watch_session) ------------------------------------
  const sessionLoop = (async (): Promise<void> => {
    while (!finished) {
      if (Date.now() >= expiresAt.getTime() - 60_000 || !(await sessionValid(auth, sessionHash))) {
        chats.wsLog?.("ws link: session expired or revoked, requesting re-auth");
        sink.send({ type: "auth_required" });
        await sleep(TERMINAL_WRITE_TIMEOUT_MS * 2);
        return;
      }
      await sleep(SESSION_WATCH_INTERVAL_MS);
    }
  })();
  void sessionLoop.then(() => finish("session"));
}

/** One socket write with the Rust TERMINAL_WRITE_TIMEOUT deadline. Returns
 *  false when the write did not complete in time (stalled socket = dead). */
async function timedSend(
  socket: WebSocket,
  output: { kind: "message"; msg: WsServerMsg } | { kind: "ping"; payload: Buffer } | { kind: "pong"; payload: Buffer },
): Promise<boolean> {
  if (socket.readyState !== socket.OPEN) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, TERMINAL_WRITE_TIMEOUT_MS);
    timer.unref?.();
    const done = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The ws callbacks pass `null` on success, an Error on failure.
      resolve(error == null);
    };
    try {
      if (output.kind === "message") {
        socket.send(serializeServerMsg(output.msg), { binary: false, fin: true }, done);
      } else if (output.kind === "ping") {
        // Server-side frames are never masked (mask=true is a protocol
        // error the client answers with a 1002 close).
        socket.ping(output.payload, false, done);
      } else {
        socket.pong(output.payload, false, done);
      }
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

/** Terminal notice flush, bypassing the queued backlog (the Rust writer's
 *  watch-channel path); 1s deadline. `alreadyWrote` dedupes double
 *  notices. */
async function terminalNotice(
  socket: WebSocket,
  msg: WsServerMsg,
  alreadyWrote: () => boolean,
): Promise<void> {
  if (!alreadyWrote()) {
    await timedSend(socket, { kind: "message", msg });
  }
}

/** Pre-registration rejection: one notice, then close. */
async function sendTerminal(socket: WebSocket, msg: WsServerMsg): Promise<void> {
  await timedSend(socket, { kind: "message", msg });
  try {
    socket.close();
  } catch {
    // already dead
  }
}

/** Waits for the sink's matched-pong register to carry this challenge (the
 *  Rust heartbeat's watch loop, 10s deadline). */
async function pongMatch(sink: SocketSink, challenge: Buffer): Promise<boolean> {
  const deadline = Date.now() + HEARTBEAT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pong = sink.backlog.lastPong;
    if (pong !== null && pong.equals(challenge)) return true;
    await sleep(PONG_POLL_MS);
  }
  return false;
}

/** One chat's state-sync bracket (Rust run_sync_started): SyncBegin, the
 *  authoritative snapshot (the chats lane's capture via the ctx seam), then
 *  SyncDone — errors ride an Error frame inside the bracket. */
async function runSyncStarted(
  chats: ChatsCtx,
  user: UserRow,
  chatId: string,
  sink: SocketSink,
): Promise<void> {
  sink.send({ type: "sync_begin", chat_id: chatId });
  try {
    const snapshot = await chats.wsSync?.({ chatId, user, sink });
    if (snapshot !== undefined && snapshot !== null) sink.send(snapshot);
    else if (chats.wsSync === undefined) {
      sink.send({ type: "error", message: "sync unavailable" });
    }
  } catch (error) {
    sink.send({
      type: "error",
      message: error instanceof ApiError ? error.message : "internal server error",
    });
  }
  sink.send({ type: "sync_done", chat_id: chatId });
}
