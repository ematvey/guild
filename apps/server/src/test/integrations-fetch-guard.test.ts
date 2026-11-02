// web_fetch/map targets are model-chosen: the guard refuses non-http(s)
// schemes and private, loopback, link-local, CGNAT and metadata targets
// before the URL reaches the scraping service. The shared body reader caps
// what a vendor response can put in memory.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPublicFetchTarget } from "../integrations/fetch-target.js";
import { readBodyCapped, requestJson, jsonErrors } from "../integrations/shared.js";
import { superproxyExecute } from "../integrations/superproxy/execute.js";
import { firecrawlExecute } from "../integrations/firecrawl/execute.js";

describe("assertPublicFetchTarget", () => {
  it.each([
    "file:///etc/passwd",
    "gopher://example.com/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://localhost:8080/",
    "http://api.localhost/",
    "http://10.0.0.5/",
    "http://172.20.1.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "not a url",
  ])("refuses %s", async (url) => {
    await expect(assertPublicFetchTarget(url)).rejects.toThrow();
  });

  it("accepts public literals and reserved test names", async () => {
    await expect(assertPublicFetchTarget("https://93.184.215.14/")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicFetchTarget("https://docs.example/page")).resolves.toBeInstanceOf(URL);
  });

  it("superproxy and firecrawl refuse a private target before calling the service", async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(
        superproxyExecute({ base_url: base }, "web_fetch", { url: "http://169.254.169.254/" }, [], null),
      ).rejects.toThrow(/not allowed/);
      await expect(
        firecrawlExecute({ base_url: base }, "web_fetch", { url: "http://127.0.0.1:5432/" }, [], null),
      ).rejects.toThrow(/not allowed/);
      await expect(
        firecrawlExecute({ base_url: base }, "map", { url: "file:///etc/passwd" }, [], null),
      ).rejects.toThrow(/http\(s\)/);
      expect(calls).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("bounded vendor bodies", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = (): void => {
          while (sent < 64 && res.write(chunk)) sent += 1;
          if (sent >= 64) res.end();
          else res.once("drain", pump);
        };
        res.on("close", () => {
          sent = 64;
        });
        pump();
        return;
      }
      if (req.url === "/fail") {
        res.writeHead(502);
        res.end("upstream exploded");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("cuts a body at the byte cap and reports truncation", async () => {
    const res = await fetch(`${base}/huge`);
    const read = await readBodyCapped(res, 1000);
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBe(1000);
  });

  it("requestJson keeps the vendor's wording for a status and parses a small body", async () => {
    await expect(requestJson(`${base}/ok`, {}, 5_000, jsonErrors("vendor"))).resolves.toEqual({ ok: true });
    await expect(requestJson(`${base}/fail`, {}, 5_000, jsonErrors("vendor"))).rejects.toThrow(
      "vendor returned 502: upstream exploded",
    );
  });
});
