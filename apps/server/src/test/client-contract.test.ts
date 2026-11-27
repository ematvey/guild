import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { acceptsSurfaceFrame, parseClientMsg } from "../hub/protocol.js";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { SocketSink, SURFACE_FRAMES } from "../hub/sink.js";
import { registerClientContracts } from "../platform/http/client-contract.js";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

describe("application API contracts", () => {
  it("publishes only the routes each frontend owns while preserving engine paths", async () => {
    const app = Fastify();
    try {
      await app.register(async (scope) => {
        registerClientContracts(scope);
        const ok = async () => ({ ok: true });
        scope.get("/api/v1/admin/users", ok);
        scope.get("/api/v1/api-keys", ok);
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
      expect(await guildStatus("GET", "api-keys")).toBe(200);
      expect(await status("GET", "control/api-keys")).toBe(200);
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

  it("matches the socket schemas to both runtime surface gates", () => {
    const readProtocol = (name: string) =>
      JSON.parse(readFileSync(new URL(`../../../../protocol/${name}.json`, import.meta.url), "utf8"));
    const schema = readProtocol("socket.schema");
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    for (const name of ["rest", "rpc", "socket"]) ajv.addSchema(readProtocol(`${name}.schema`));
    const clientFrames: Record<string, unknown>[] = readProtocol("fixtures/socket.ClientFrame");
    const serverFrames: { type: string }[] = readProtocol("fixtures/socket.ServerFrame");
    const id = "00000000-0000-4000-8000-000000000001";
    const optionalFields = ["run_id", "activity_chat_id", "coordination_agent_id"];
    for (const chatId of [undefined, null, id]) {
      for (let mask = 0; mask < 2 ** optionalFields.length; mask++) {
        clientFrames.push({
          type: "sync",
          ...(chatId === undefined ? {} : { chat_id: chatId }),
          ...Object.fromEntries(optionalFields.filter((_, bit) => (mask & (1 << bit)) !== 0).map((field) => [field, id])),
        });
      }
    }

    for (const [surface, prefix] of [["work", "Work"], ["control", "Control"]] as const) {
      const clientRoot = `${prefix}ClientFrame`;
      const serverRoot = `${prefix}ServerFrame`;
      expect(schema.$defs[clientRoot].allOf[0]).toEqual({ $ref: "#/$defs/ClientFrame" });
      expect(schema.$defs[serverRoot].allOf[0]).toEqual({ $ref: "#/$defs/ServerFrame" });
      const validateClient = ajv.compile({ $ref: `${schema.$id}#/$defs/${clientRoot}` });
      const validateServer = ajv.compile({ $ref: `${schema.$id}#/$defs/${serverRoot}` });
      const allowedServerTags = schema.$defs[serverRoot].allOf[1].properties.type.enum;
      expect([...SURFACE_FRAMES[surface]]).toEqual(allowedServerTags);
      for (const frame of serverFrames) {
        expect(validateServer(frame), `${surface} server frame ${frame.type}`).toBe(allowedServerTags.includes(frame.type));
      }
      for (const frame of clientFrames) {
        const text = JSON.stringify(frame);
        const parsed = parseClientMsg(text);
        expect(parsed, text).not.toBeNull();
        expect(validateClient(frame), `${surface} client frame ${text}`).toBe(acceptsSurfaceFrame(surface, parsed!));
      }
    }
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
