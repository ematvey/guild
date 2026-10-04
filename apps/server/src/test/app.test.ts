// App-shell tests: native health route + proxy-everything (HTTP and WS
// upgrade) against a fake in-process Rust-server stand-in. No external
// services.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp, GUILD_TS_SERVER_VERSION, NATIVE_ROUTES } from "../app.js";
import { loadConfig } from "../config.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
let last: CapturedRequest | undefined;
const getLast = (): CapturedRequest | undefined => last;
let wss: WebSocketServer;

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      last = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      if (req.url === "/api/v1/upstream-only-404") {
        res.writeHead(404, { "content-type": "text/plain", "x-upstream": "yes" });
        res.end("nope");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-upstream": "yes",
        "x-upstream-last-path": req.url ?? "",
      });
      res.end(JSON.stringify({ upstream: true, path: req.url }));
    });
  });
  // WS echo server on the same port — the hub route stand-in.
  wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(`echo:${data.toString()}`);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const TEST_ENV = {
  GUILD_UPSTREAM_URL: "",
  GUILD_MASTER_KEY_HEX: "00".repeat(32),
  GUILD_JWT_SECRET: "test-secret",
};

function makeApp() {
  return buildApp(loadConfig({ ...TEST_ENV, GUILD_UPSTREAM_URL: upstreamUrl, GUILD_LOG_LEVEL: "silent" }));
}

describe("health route (native)", () => {
  it("serves /api/v1/health itself, in the Rust shape", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", version: GUILD_TS_SERVER_VERSION });
    await app.close();
  });

  it("does not hit the upstream", async () => {
    last = undefined;
    const app = await makeApp();
    await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(getLast()).toBeUndefined();
    await app.close();
  });

  it("NATIVE_ROUTES covers the health path and the platform groups", () => {
    expect(NATIVE_ROUTES).toEqual([
      "/api/v1/health",
      "/api/v1/auth/*",
      "/api/v1/org",
      "/api/v1/org/logo",
      "/api/v1/orgs/*/logo",
      "/api/v1/events",
      "/api/v1/attachments/*",
      "/api/v1/chats/*/attachments",
      "/api/v1/auth/oidc/*",
      "/api/v1/admin/oidc",
      "/api/v1/gateway/models",
      "/api/v1/admin/gateway/*",
      "/api/v1/api-keys",
      "/api/v1/api-keys/*",
      "/api/v1/admin/api-keys",
      "/api/v1/admin/api-keys/*",
      "/api/v1/usage",
      "/api/v1/usage/*",
      "/openai/v1/*",
      "/anthropic/v1/*",
      // M5 hub core (the ws upgrade itself is a server-level 'upgrade'
      // listener, not an HTTP route).
      "/api/v1/machines",
      "/api/v1/machines/*",
      "/api/v1/ws/ticket",
      "/api/v1/chats",
      "/api/v1/chats/*",
      "/api/v1/gateway/chat",
      "/api/v1/gateway/chat/*",
      // M6 long tail. admin-integrations is a partial flip (see the group's
      // comment in register.ts).
      "/api/v1/registry/*",
      "/api/v1/releases",
      "/api/v1/releases/*",
      "/api/v1/admin/releases",
      "/api/v1/admin/releases/*",
      "/api/v1/updates/latest.json",
      "/api/v1/projects",
      "/api/v1/projects/*",
      "/api/v1/admin/teams",
      "/api/v1/admin/teams/*",
      "/api/v1/admin/users",
      "/api/v1/admin/users/*",
      "/api/v1/admin/assistant-prompt",
      "/api/v1/admin/approval-policy-prompt",
      "GET /api/v1/admin/integrations",
      "GET /api/v1/admin/integrations/*/secrets",
      "PUT /api/v1/admin/integrations/*/tools/*",
      "DELETE /api/v1/admin/integrations/*",
      // M4: workspace agent sessions + tool artifacts.
      "/api/v1/agents/sessions",
      "/api/v1/agents/sessions/*",
      "/api/v1/tool_artifacts/*",
      "/api/v1/chats/*/tool_artifacts",
    ]);
  });
});

describe("proxy-everything (HTTP)", () => {
  it("forwards status, headers and body from the upstream", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/upstream-only-404" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("nope");
    expect(res.headers["x-upstream"]).toBe("yes");
    await app.close();
  });

  it("forwards method, path, query and raw request body to the upstream", async () => {
    last = undefined;
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/attachments?org=o1",
      payload: "raw-bytes-not-parsed",
      headers: { "content-type": "application/octet-stream" },
    });
    expect(res.statusCode).toBe(200);
    expect(getLast()?.method).toBe("POST");
    expect(getLast()?.url).toBe("/api/v1/attachments?org=o1");
    expect(getLast()?.body).toBe("raw-bytes-not-parsed");
    await app.close();
  });

  it("non-API GET paths are the SPA fallback now (M6 web serving): 503 without a dist", async () => {
    last = undefined;
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/thread/abc123" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("chat app not built");
    expect(getLast()).toBeUndefined();
    await app.close();
  });
});

describe("hub WS upgrade (native since M5)", () => {
  it("the upgrade is native now: an upgrade without a ticket is rejected by the hub itself", async () => {
    const app = await makeApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    client.on("error", () => {}); // the rejection below is the expected path
    const failure = await new Promise<{ code: number; message: string }>((resolve) => {
      client.on("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            code: res.statusCode ?? 0,
            message: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      client.on("open", () => resolve({ code: 0, message: "unexpectedly opened" }));
    });
    expect(failure.code).toBe(400);
    expect(failure.message).toContain("missing query parameter: ticket");
    try {
      client.terminate();
    } catch {
      // The ws client may already be tearing down the rejected connection.
    }
    await app.close();
  });
});
