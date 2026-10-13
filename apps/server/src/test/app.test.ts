// App-shell tests: the native surface (health, platform groups, the
// Rust-shaped not-found envelope for deferred routes, the SPA fallback, the
// hub WS upgrade). No external services, no upstream — the Rust server is
// retired (M7).

import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp, GUILD_TS_SERVER_VERSION, NATIVE_ROUTES } from "../app.js";
import { loadConfig } from "../config.js";

let wss: WebSocketServer;

beforeAll(async () => {
  // WS echo server — the hub route stand-in.
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(`echo:${data.toString()}`);
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

const TEST_ENV = {
  GUILD_MASTER_KEY_HEX: "00".repeat(32),
  GUILD_JWT_SECRET: "test-secret",
};

function makeApp() {
  return buildApp(loadConfig({ ...TEST_ENV, GUILD_LOG_LEVEL: "silent" }));
}

describe("health route (native)", () => {
  it("serves /api/v1/health itself, in the Rust shape", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", version: GUILD_TS_SERVER_VERSION });
    await app.close();
  });

  it("NATIVE_ROUTES covers the health path and the platform groups", () => {
    expect(NATIVE_ROUTES).toEqual([
      "/api/v1/health",
      "/api/v1/auth/*",
      "/api/v1/me/approval",
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
      // M6 long tail: registry, releases, projects, teams, admin reads.
      "/api/v1/registry/*",
      "/api/v1/skills",
      "/api/v1/skills/*",
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
      // M7: the full admin integration CRUD + the script-facing tool API.
      "/api/v1/admin/integrations",
      "/api/v1/admin/integrations/*",
      "/api/v1/integrations",
      "/api/v1/integrations/*",
      // M4: workspace agent sessions + tool artifacts.
      "/api/v1/agents/sessions",
      "/api/v1/agents/sessions/*",
      "/api/v1/tool_artifacts/*",
      "/api/v1/chats/*/tool_artifacts",
    ]);
  });
});

describe("deferred routes (spec decision 8)", () => {
  it.each([
    ["/api/v1/routines", "POST"],
    ["/api/v1/routines/abc", "GET"],
    ["/api/v1/routines/abc/runs", "GET"],
    ["/api/v1/hooks/org-1/slack", "POST"],
    ["/api/v1/internal/runs", "POST"],
    ["/api/v1/internal/storage", "POST"],
    ["/api/v1/internal/completion", "POST"],
    ["/api/v1/some/other/unported", "GET"],
  ])("%s %s answers the Rust not-found envelope, not a connection error", async (url, method) => {
    const app = await makeApp();
    const res = await app.inject({ method: method as "GET" | "POST", url });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
    await app.close();
  });
});

describe("web UI fallback", () => {
  it("non-API GET paths are the SPA fallback: 503 without a dist", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/thread/abc123" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("chat app not built");
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
