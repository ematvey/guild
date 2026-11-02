// The golden-WS scenario driver: one scenario, run by the vitest replay
// against the server, comparing every text frame with the fixed capture in
// platform/fixtures/ws-golden.json after masking dynamic values
// (uuids/timestamps/tickets) with the same normalizer.

import WebSocket from "ws";
import crypto from "node:crypto";

export type FrameRecord =
  | { kind: "text"; data: string; t?: number }
  | { kind: "ping"; data: string; t?: number }
  | { kind: "pong"; data: string; t?: number }
  | { kind: "closed"; data: ""; t?: number };

export class ScriptedClient {
  private ws!: WebSocket;
  readonly frames: FrameRecord[] = [];
  private readonly openPromise: Promise<void>;
  private closedResolve: (() => void) | null = null;
  upgradeFailure: { code: number; message: string } | null = null;

  constructor(
    base: string,
    query: string,
    private readonly autoPong = true,
  ) {
    this.openPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/ws?${query}`);
      this.ws.on("open", resolve);
      this.ws.on("error", (err: Error & { code?: number; message?: string }) => {
        // Handshake rejections surface here with the HTTP status in the
        // message ("Unexpected server response: 401"). The
        // 'unexpected-response' handler (if it fires) records the precise
        // response; don't overwrite its result.
        if (this.upgradeFailure === null) {
          this.upgradeFailure = { code: err.code ?? 0, message: err.message ?? String(err) };
        }
        reject(err);
      });
      this.ws.on("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          this.upgradeFailure = {
            code: res.statusCode ?? 0,
            message: Buffer.concat(chunks).toString("utf8"),
          };
          // Handling 'unexpected-response' suppresses ws's own error
          // emission; settle the open promise here or it hangs forever.
          this.ws.terminate();
          reject(new Error(`upgrade rejected: ${res.statusCode}`));
        });
      });
      this.ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        this.frames.push({ kind: "text", data: data.toString("utf8"), t: Date.now() });
      });
      this.ws.on("ping", (data: Buffer) => {
        this.frames.push({ kind: "ping", data: data.toString("hex"), t: Date.now() });
        if (this.autoPong) this.ws.pong(data, true, () => {});
      });
      this.ws.on("pong", (data: Buffer) => {
        this.frames.push({ kind: "pong", data: data.toString("hex") });
      });
      this.ws.on("close", () => {
        this.frames.push({ kind: "closed", data: "", t: Date.now() });
        this.closedResolve?.();
      });
    });
  }

  async open(): Promise<void> {
    await this.openPromise;
  }

  /** Awaits the close (or resolves immediately if already closed). */
  async closed(timeoutMs = 10_000): Promise<void> {
    if (this.frames.some((f) => f.kind === "closed")) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.closedResolve = resolve;
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  send(text: string): void {
    this.ws.send(text);
  }

  end(): void {
    this.ws.close();
  }

  async until(predicate: (frame: FrameRecord) => boolean, timeoutMs = 15_000): Promise<FrameRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`frame not found within ${timeoutMs}ms: ${JSON.stringify(this.frames)}`);
  }
}

/** Masks every dynamic value so the two implementations byte-compare:
 *  uuids → __UUID__, RFC 3339 timestamps → __TS__, 16-byte ping/pong
 *  payloads → __UUIDBYTES__ (shape-checked separately in the replay). */
export function normalizeFrame(data: string): string {
  return data
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "__UUID__")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/g, "__TS__")
    .replace(/gst_[0-9a-f]{32}/g, "__TICKET__");
}

export function normalizeHexPayload(hex: string): string {
  if (/^[0-9a-f]{32}$/.test(hex)) {
    // uuid v7: version nibble is the first hex digit of the 13th byte pair
    // (chars 12–13 of the concatenated hex).
    return `__UUIDBYTES_v${hex[12]}__`;
  }
  return hex;
}

export interface HttpStep {
  method: string;
  path: string;
  body?: unknown;
  token?: string;
}

export interface ScenarioResult {
  /** Ordered, named steps; each records the frames one socket received and
   *  any HTTP responses. */
  steps: ScenarioStep[];
}

export interface ScenarioStep {
  name: string;
  /** Raw inbound frames of the step's socket(s), in arrival order. */
  frames: { socket: number; frame: FrameRecord }[];
  http?: { status: number; body: string }[];
  /** Whether the socket's upgrade failed (handshake rejection). */
  upgradeFailure?: { code: number; message: string } | null;
}

async function http(
  base: string,
  step: HttpStep,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${step.path}`, {
    method: step.method,
    headers: {
      ...(step.token !== undefined ? { authorization: `Bearer ${step.token}` } : {}),
      ...(step.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(step.body !== undefined ? { body: JSON.stringify(step.body) } : {}),
  });
  const body = await res.text();
  return { status: res.status, body };
}

async function ticket(base: string, token: string): Promise<string> {
  const res = await http(base, { method: "POST", path: "/api/v1/ws/ticket", token });
  if (res.status !== 200) throw new Error(`ticket mint failed: ${res.status} ${res.body}`);
  return (JSON.parse(res.body) as { ticket: string }).ticket;
}

export interface ScenarioOptions {
  machineId: string;
  machineName: string;
  fingerprint: string;
  /** Direct chat-row insert for environments where POST /api/v1/chats is
   *  still proxied (chats routes belong to the M3 lane). */
  createChatFallback?: (orgId: string, userId: string) => Promise<void>;
}

/** The full fixture scenario: login → ticket → member connect → machine
 *  connect (with metadata) → heartbeat ping/pong → fs dispatch round-trip →
 *  displaced/stale-resume/same-instance reconnect → bad-ticket rejection →
 *  chat-bound thread list. The daemon (scripted client) answers server
 *  pings and machine_requests exactly like the real executor does. */
export async function runScenario(
  base: string,
  opts: ScenarioOptions,
  onStep: (step: ScenarioStep) => void,
): Promise<void> {
  const bootstrap = await http(base, {
    method: "POST",
    path: "/api/v1/auth/bootstrap",
    body: { email: "ws-capture@example.test", password: "capture-password-1" },
  });
  if (bootstrap.status !== 200 && bootstrap.status !== 409) {
    throw new Error(`bootstrap failed: ${bootstrap.status} ${bootstrap.body}`);
  }
  const login = await http(base, {
    method: "POST",
    path: "/api/v1/auth/login",
    body: { email: "ws-capture@example.test", password: "capture-password-1" },
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.body}`);
  const loginBody = JSON.parse(login.body) as { token: string; user: { id: string; org_id: string } };
  const token = loginBody.token;

  const step = (name: string): ScenarioStep => {
    const s: ScenarioStep = { name, frames: [] };
    onStep(s);
    return s;
  };

  // -- member connect -------------------------------------------------------
  {
    const s = step("member-connect");
    const t = await ticket(base, token);
    const ws = new ScriptedClient(base, `ticket=${t}`);
    await ws.open();
    await ws.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    const hello = ws.frames.find((f) => f.kind === "text" && f.data.includes("hello"))!;
    const threadList = ws.frames.find((f) => f.kind === "text" && f.data.includes("thread_list"))!;
    s.frames.push({ socket: 0, frame: hello });
    s.frames.push({ socket: 0, frame: threadList });
    ws.end();
    await ws.closed();
    s.frames.push({ socket: 0, frame: ws.frames[ws.frames.length - 1]! });
  }

  // -- machine connect with registry metadata -------------------------------
  {
    const s = step("machine-connect");
    const t = await ticket(base, token);
    const ws = new ScriptedClient(
      base,
      `ticket=${t}&client_id=capture-client&machine_id=${opts.machineId}&machine_name=${opts.machineName}` +
        `&machine_fingerprint=${opts.fingerprint}&machine_os=Linux&machine_os_version=6.1&machine_app_version=0.5.34` +
        `&instance_id=${crypto.randomUUID()}&resume=false`,
    );
    await ws.open();
    await ws.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    const hello = ws.frames.find((f) => f.kind === "text" && f.data.includes("hello"))!;
    const threadList = ws.frames.find((f) => f.kind === "text" && f.data.includes("thread_list"))!;
    s.frames.push({ socket: 0, frame: hello });
    s.frames.push({ socket: 0, frame: threadList });
    // The durable registry row is visible immediately.
    const machines = await http(base, { method: "GET", path: "/api/v1/machines", token });
    s.http = [machines];
    // Keep the socket open for the heartbeat + dispatch steps.
    globalThis.__m5MachineWs = ws;
  }

  // -- heartbeat: the server pings every 5s; answer with a matched pong ------
  {
    const s = step("machine-heartbeat");
    const ws = globalThis.__m5MachineWs as ScriptedClient;
    const ping = await ws.until((f) => f.kind === "ping", 15_000);
    const pong = ws.frames.find((f) => f.kind === "pong" && f.data === ping.data);
    s.frames.push({ socket: 0, frame: ping });
    if (pong !== undefined) s.frames.push({ socket: 0, frame: pong });
  }

  // -- control-plane dispatch round-trip (fs_home) ---------------------------
  {
    const s = step("fs-roundtrip");
    const ws = globalThis.__m5MachineWs as ScriptedClient;
    const post = http(base, {
      method: "POST",
      path: `/api/v1/machines/${opts.machineId}/fs`,
      token,
      body: { op: "fs_home" },
    });
    const reqFrame = await ws.until(
      (f) => f.kind === "text" && f.data.includes("machine_request"),
    );
    const requestId = (JSON.parse((reqFrame as { data: string }).data) as { request_id: string })
      .request_id;
    ws.send(
      JSON.stringify({
        type: "machine_response",
        request_id: requestId,
        ok: true,
        payload: { home: "/home/capture" },
      }),
    );
    s.frames.push({ socket: 0, frame: reqFrame });
    const res = await post;
    s.http = [res];
  }

  // -- unknown op rejected -----------------------------------------------------
  {
    const s = step("fs-unknown-op");
    const res = await http(base, {
      method: "POST",
      path: `/api/v1/machines/${opts.machineId}/fs`,
      token,
      body: { op: "fs_write_everything" },
    });
    s.http = [res];
  }

  // -- foreign machine id: unknown machine → 404 ------------------------------
  {
    const s = step("fs-unknown-machine");
    const res = await http(base, {
      method: "POST",
      path: `/api/v1/machines/00000000-0000-0000-0000-000000000000/fs`,
      token,
      body: { op: "fs_home" },
    });
    s.http = [res];
  }

  // -- second instance is REJECTED (0.5.25 live-slot rule); holder unharmed ---
  {
    const s = step("foreign-instance-rejected");
    const ws = globalThis.__m5MachineWs as ScriptedClient;
    const t = await ticket(base, token);
    const thief = new ScriptedClient(
      base,
      `ticket=${t}&machine_id=${opts.machineId}&instance_id=${crypto.randomUUID()}&resume=false`,
    );
    await thief.open().catch(() => {});
    await thief.until((f) => f.kind === "text" && f.data.includes("displaced"), 10_000).catch(() => {});
    await thief.closed();
    s.frames.push(...thief.frames.map((f) => ({ socket: 1, frame: f })));
    s.upgradeFailure = thief.upgradeFailure;
    // The holder keeps the slot and stays connected (no data frames arrive
    // for it; heartbeat pings continue as usual and don't count).
    const before = ws.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const disturbed = ws.frames
      .slice(before)
      .some((f) => f.kind === "closed" || f.kind === "text");
    if (disturbed) throw new Error("holder socket was disturbed by the rejected connect");
  }

  // -- stale resume from a different instance is likewise rejected -------------
  {
    const s = step("stale-resume-rejected");
    const t = await ticket(base, token);
    const stale = new ScriptedClient(
      base,
      `ticket=${t}&machine_id=${opts.machineId}&instance_id=${crypto.randomUUID()}&resume=true`,
    );
    await stale.open().catch(() => {});
    await stale.closed();
    s.frames.push(...stale.frames.map((f) => ({ socket: 2, frame: f })));
  }

  // -- same-instance reconnect displaces its own zombie slot -------------------
  {
    const s = step("same-instance-reconnect");
    const instanceId = crypto.randomUUID();
    const t1 = await ticket(base, token);
    const first = new ScriptedClient(
      base,
      `ticket=${t1}&machine_id=${opts.machineId}-2&instance_id=${instanceId}&resume=false`,
    );
    await first.open();
    await first.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    const t2 = await ticket(base, token);
    const second = new ScriptedClient(
      base,
      `ticket=${t2}&machine_id=${opts.machineId}-2&instance_id=${instanceId}&resume=false`,
    );
    await second.open();
    await second.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    await first.until((f) => f.kind === "text" && f.data.includes("displaced"));
    await first.closed();
    const displacedFrame = first.frames.find((f) => f.kind === "text" && f.data.includes("displaced"))!;
    const closedFrame = first.frames.find((f) => f.kind === "closed")!;
    const secondHello = second.frames.find((f) => f.kind === "text" && f.data.includes("hello"))!;
    const secondList = second.frames.find((f) => f.kind === "text" && f.data.includes("thread_list"))!;
    s.frames.push({ socket: 0, frame: displacedFrame });
    s.frames.push({ socket: 0, frame: closedFrame });
    s.frames.push({ socket: 1, frame: secondHello });
    s.frames.push({ socket: 1, frame: secondList });
    first.end();
    second.end();
  }

  // -- bad ticket rejected at the handshake ------------------------------------
  {
    const s = step("bad-ticket");
    const bad = new ScriptedClient(base, `ticket=gst_deadbeefdeadbeefdeadbeefdeadbeef`);
    await bad.open().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    s.upgradeFailure = bad.upgradeFailure;
  }

  // -- missing instance_id on a machine connect → 400 ---------------------------
  {
    const s = step("machine-without-instance");
    const t = await ticket(base, token);
    const bad = new ScriptedClient(base, `ticket=${t}&machine_id=${opts.machineId}-3`);
    await bad.open().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    s.upgradeFailure = bad.upgradeFailure;
  }

  // -- chat-bound thread list (the Chat JSON wire shape) -------------------------
  {
    const s = step("chat-thread-list");
    const create = await http(base, {
      method: "POST",
      path: "/api/v1/chats",
      token,
      body: { title: "capture" },
    });
    if (create.status !== 200) {
      // The chats routes are still proxied in the TS test environment (the
      // M3 lane's territory) — no upstream answers there. The replay creates
      // the equivalent row directly; the byte-compared surface is the
      // thread_list frame, not the creation route.
      await opts.createChatFallback?.(loginBody.user.org_id, loginBody.user.id);
    }
    const t = await ticket(base, token);
    const ws = new ScriptedClient(base, `ticket=${t}`);
    await ws.open();
    await ws.until((f) => f.kind === "text" && f.data.includes("thread_list"));
    const threadList = ws.frames.find((f) => f.kind === "text" && f.data.includes("thread_list"))!;
    s.frames.push({ socket: 0, frame: threadList });
    ws.end();
    const ws2 = globalThis.__m5MachineWs as ScriptedClient | undefined;
    ws2?.end();
  }
}

declare const globalThis: { __m5MachineWs?: ScriptedClient };
