import { describe, expect, it } from "vitest";
import { DEFAULT_BIND_ADDR, DEFAULT_LOG_LEVEL, DEFAULT_UPSTREAM_URL, loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("uses defaults on empty env", () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual({
      bindHost: "0.0.0.0",
      bindPort: 8080,
      upstreamUrl: "http://server-rust:8080",
      logLevel: "info",
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
    });
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.bindPort).toBe(9090);
    expect(cfg.upstreamUrl).toBe("http://rust:1234");
    expect(cfg.logLevel).toBe("debug");
  });

  it("normalizes the upstream URL (trailing slash, path, query stripped)", () => {
    expect(loadConfig({ GUILD_UPSTREAM_URL: "https://upstream.example/" }).upstreamUrl).toBe(
      "https://upstream.example",
    );
    expect(loadConfig({ GUILD_UPSTREAM_URL: "http://host:8080/a/b?x=1" }).upstreamUrl).toBe(
      "http://host:8080",
    );
  });

  it("parses IPv6-style bind addrs ([::]:8080)", () => {
    const cfg = loadConfig({ GUILD_BIND_ADDR: "[::]:8080" });
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
});
