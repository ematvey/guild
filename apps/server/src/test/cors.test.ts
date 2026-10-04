import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

// The CORS layer port (crates/server/src/http/mod.rs): preflights answered
// 204 with ACAO only for the allow-listed webview origins.
function cfg() {
  return loadConfig({ GUILD_MASTER_KEY_HEX: "00".repeat(32), GUILD_JWT_SECRET: "s" });
}

describe("cors", () => {
  it("answers an allowed-origin preflight with 204 + ACAO", async () => {
    const app = await buildApp(cfg());
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/ws/ticket",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    expect(res.headers["access-control-allow-methods"]).toBe("*");
    await app.close();
  });

  it("answers a non-allowed-origin preflight with 204 and no ACAO", async () => {
    const app = await buildApp(cfg());
    const res = await app.inject({
      method: "OPTIONS",
      url: "/faro/collect",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("rides ACAO on real responses for allowed origins only", async () => {
    const app = await buildApp(cfg());
    const ok = await app.inject({ method: "GET", url: "/api/v1/health", headers: { origin: "http://tauri.localhost" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
    const no = await app.inject({ method: "GET", url: "/api/v1/health", headers: { origin: "https://evil.example" } });
    expect(no.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
