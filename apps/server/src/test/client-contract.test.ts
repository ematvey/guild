import { readFileSync } from "node:fs";
import { acceptsSurfaceFrame } from "../hub/protocol.js";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { SocketSink, SURFACE_FRAMES } from "../hub/sink.js";
import { registerClientContracts } from "../platform/http/client-contract.js";

describe("application API contracts", () => {
  it("publishes only the routes each frontend owns while preserving engine paths", async () => {
    const app = Fastify();
    try {
      await app.register(async (scope) => {
        registerClientContracts(scope);
        const ok = async () => ({ ok: true });
        scope.get("/api/v1/admin/users", ok);
        scope.get("/api/v1/auth/me", ok);
        scope.post("/api/v1/chats/:id/turns", ok);
        scope.post("/api/v1/sidebar/pins/:id/order", ok);
        scope.post("/api/v1/assistant", ok);
        scope.post("/api/v1/agents", ok);
        scope.get("/api/v1/agents", ok);
        scope.patch("/api/v1/agents/:id/routines/:rid", ok);
        scope.get("/api/v1/skills", ok);
        scope.post("/api/v1/skills", ok);
      });
      const status = async (method: "GET" | "POST" | "HEAD" | "PATCH", url: string) =>
        (await app.inject({ method, url: "/api/v1/" + url })).statusCode;

      const guildStatus = async (method: "GET" | "POST" | "HEAD" | "PATCH", path: string) =>
        (await app.inject({ method, url: "/api/v1/" + path, headers: { "x-guild-client-surface": "guild" } })).statusCode;
      expect(await guildStatus("HEAD", "auth/me")).toBe(200);
      expect(await guildStatus("POST", "chats/chat/turns")).toBe(200);
      expect(await guildStatus("PATCH", "agents/agent/routines/task")).toBe(200);
      expect(await guildStatus("GET", "admin/users")).toBe(404);
      expect(await guildStatus("POST", "agents")).toBe(404);
      expect(await status("GET", "admin/users")).toBe(200);

      expect(await status("GET", "work/auth/me")).toBe(200);
      expect(await status("HEAD", "control/auth/me")).toBe(200);
      expect(await status("GET", "control/admin/users")).toBe(200);
      expect(await status("GET", "work/admin/users")).toBe(404);
      expect(await status("POST", "work/chats/chat/turns")).toBe(200);
      expect(await status("POST", "control/chats/chat/turns")).toBe(404);
      expect(await status("POST", "work/sidebar/pins/chat/order")).toBe(200);
      expect(await status("POST", "control/assistant")).toBe(200);
      expect(await status("GET", "work/agents")).toBe(200);
      expect(await status("POST", "work/agents")).toBe(404);
      expect(await status("POST", "control/agents")).toBe(200);
      expect(await status("POST", "agents")).toBe(200);
      expect(await status("PATCH", "work/agents/agent/routines/routine")).toBe(200);
      expect(await status("GET", "work/skills")).toBe(200);
      expect(await status("POST", "work/skills")).toBe(404);
      expect(await status("POST", "control/skills")).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("matches the published socket vocabulary and rejects cross-surface commands", () => {
    const schemaUrl = new URL("../../../../protocol/socket.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
    const tags = (name: string) => schema.$defs[name].allOf[1].properties.type.enum;
    expect([...SURFACE_FRAMES.work]).toEqual(tags("WorkServerFrame"));
    expect([...SURFACE_FRAMES.control]).toEqual(tags("ControlServerFrame"));
    const id = "00000000-0000-4000-8000-000000000001";
    expect(acceptsSurfaceFrame("work", { type: "read", chat_id: id })).toBe(true);
    expect(acceptsSurfaceFrame("control", { type: "read", chat_id: id })).toBe(false);
    expect(acceptsSurfaceFrame("work", { type: "sync", chat_id: null, run_id: id })).toBe(false);
    expect(acceptsSurfaceFrame("control", { type: "sync", chat_id: null, run_id: id })).toBe(true);
    expect(acceptsSurfaceFrame("control", { type: "sync", chat_id: id })).toBe(false);
  });

  it("keeps chat state on the Work socket and integration configuration on Control", () => {
    const work = new SocketSink([], "work");
    const control = new SocketSink([], "control");
    const threads = { type: "thread_list", chats: [] } as const;
    const integrations = { type: "integration_access", integrations: [] } as const;
    for (const sink of [work, control]) {
      sink.send({ ...threads, chats: [] });
      sink.send({ ...integrations, integrations: [] });
    }
    expect(work.take()?.kind).toBe("message");
    expect(work.take()).toBeUndefined();
    expect(control.take()).toMatchObject({ kind: "message", msg: { type: "integration_access" } });
    expect(control.take()).toBeUndefined();
  });
});
