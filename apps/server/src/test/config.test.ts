import { describe, expect, it } from "vitest";
import { DEFAULT_BIND_ADDR, DEFAULT_LOG_LEVEL, DEFAULT_UPSTREAM_URL, loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("uses defaults on empty env", () => {
    const cfg = loadConfig({ GUILD_MASTER_KEY_HEX: "00".repeat(32), GUILD_JWT_SECRET: "s" });
    expect(cfg).toEqual({
      bindHost: "0.0.0.0",
      bindPort: 8080,
      upstreamUrl: "http://server-rust:8080",
      logLevel: "info",
      databaseUrl: "postgres://guild:guild@localhost:5432/guild",
      masterKeyHex: "00".repeat(32),
      jwtSecret: "s",
      s3Url: "http://localhost:9000",
      s3Bucket: "guild",
      s3AccessKeyId: "minioadmin",
      s3SecretAccessKey: "minioadmin",
      apiUrl: "http://localhost:8080",
      clickhouseUrl: "http://localhost:8123",
      clickhouseDatabase: "guild",
      clickhouseUser: "",
      clickhousePassword: "",
      internalKey: null,
      selfBaseUrl: "http://127.0.0.1:8080",
    });
    expect(DEFAULT_BIND_ADDR).toBe("0.0.0.0:8080");
    expect(DEFAULT_UPSTREAM_URL).toBe("http://server-rust:8080");
    expect(DEFAULT_LOG_LEVEL).toBe("info");
  });

  it("reads GUILD_BIND_ADDR, GUILD_UPSTREAM_URL and GUILD_LOG_LEVEL", () => {
    const cfg = loadConfig({
      GUILD_BIND_ADDR: "127.0.0.1:9090",
      GUILD_UPSTREAM_URL: "http://rust:1234/base",
      GUILD_LOG_LEVEL: "debug",
      GUILD_MASTER_KEY_HEX: "11".repeat(32),
      GUILD_JWT_SECRET: "s",
    });
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.bindPort).toBe(9090);
    expect(cfg.upstreamUrl).toBe("http://rust:1234");
    expect(cfg.logLevel).toBe("debug");
  });

  it("normalizes the upstream URL (trailing slash, path, query stripped)", () => {
    const env = { GUILD_MASTER_KEY_HEX: "00".repeat(32), GUILD_JWT_SECRET: "s" };
    expect(loadConfig({ ...env, GUILD_UPSTREAM_URL: "https://upstream.example/" }).upstreamUrl).toBe(
      "https://upstream.example",
    );
    expect(loadConfig({ ...env, GUILD_UPSTREAM_URL: "http://host:8080/a/b?x=1" }).upstreamUrl).toBe(
      "http://host:8080",
    );
  });

  it("parses IPv6-style bind addrs ([::]:8080)", () => {
    const cfg = loadConfig({
      GUILD_BIND_ADDR: "[::]:8080",
      GUILD_MASTER_KEY_HEX: "00".repeat(32),
      GUILD_JWT_SECRET: "s",
    });
    expect(cfg.bindHost).toBe("[::]");
    expect(cfg.bindPort).toBe(8080);
  });

  it("rejects invalid bind addrs and upstream URLs", () => {
    expect(() => loadConfig({ GUILD_BIND_ADDR: "no-port" })).toThrow(/missing port/);
    expect(() => loadConfig({ GUILD_BIND_ADDR: ":8080" })).toThrow(/missing host/);
    expect(() => loadConfig({ GUILD_BIND_ADDR: "0.0.0.0:99999" })).toThrow(/invalid port/);
    expect(() => loadConfig({ GUILD_UPSTREAM_URL: "not a url" })).toThrow(/not a valid URL/);
    expect(() => loadConfig({ GUILD_UPSTREAM_URL: "ftp://host" })).toThrow(/must be http/);
  });

  it("requires the master key and JWT secret, and validates the key", () => {
    expect(() => loadConfig({})).toThrow(/GUILD_MASTER_KEY_HEX/);
    expect(() => loadConfig({ GUILD_MASTER_KEY_HEX: "00".repeat(32) })).toThrow(/GUILD_JWT_SECRET/);
    expect(() =>
      loadConfig({ GUILD_MASTER_KEY_HEX: "zz".repeat(32), GUILD_JWT_SECRET: "s" }),
    ).toThrow(/64 hex chars/);
    expect(() => loadConfig({ GUILD_MASTER_KEY_HEX: "00".repeat(31), GUILD_JWT_SECRET: "s" })).toThrow(
      /64 hex chars/,
    );
  });

  it("normalizes GUILD_API_URL (trailing slash stripped)", () => {
    expect(loadConfig({ GUILD_MASTER_KEY_HEX: "00".repeat(32), GUILD_JWT_SECRET: "s", GUILD_API_URL: "https://api.example.com/" }).apiUrl).toBe(
      "https://api.example.com",
    );
  });
});
