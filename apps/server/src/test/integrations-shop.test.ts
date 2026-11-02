// The integration shop and trait surface: the plugin manifests load, the
// trait tools take Guild-provided names and descriptions, only one
// integration provides a given trait, and the Grafana plugin speaks the
// datasource-proxy paths the real server uses.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTEGRATIONS, integrationByName } from "../integrations/loader.js";
import { resolveIntegrations } from "../integrations/plugins.js";
import { grafanaExecute } from "../integrations/grafana/execute.js";

const SECRETS: [string, string][] = [["token", "glsa_test"]];

function gateway(rows: { name: string; config: unknown; enabled: boolean }[]) {
  return {
    integrations: { listEnabled: async () => rows },
    integrationSecrets: {
      names: async () => [],
      resolve: async () => SECRETS,
    },
    masterKey: () => Buffer.alloc(32, 1),
    registry: {
      approvedBundle: async () => null,
      getVersion: async () => ({ manifest: {}, bundle_sha256: null, object_key: "" }),
    },
  };
}

describe("integration catalog", () => {
  it("loads every plugin with a unique slug, a summary, and a logo", () => {
    const names = INTEGRATIONS.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    for (const integration of INTEGRATIONS) {
      expect(integration.summary).not.toBe("");
      expect(integration.description).not.toBe("");
      expect(integration.logo).toContain("<svg");
      expect(integration.tools.every((t) => ["read", "write", "admin"].includes(t.class))).toBe(true);
    }
  });

  it("ships Grafana with the observability tools", () => {
    const grafana = integrationByName("grafana")!;
    expect(grafana.categories).toEqual(["observability"]);
    expect(
      grafana
        .toolSpecs({ base_url: "https://grafana.example.test" })
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "api",
      "get_dashboard",
      "list_alerts",
      "list_dashboards",
      "list_datasources",
      "query_logs",
      "query_metrics",
    ]);
  });
});

describe("trait tools", () => {
  it("take the Guild-provided name and description", async () => {
    const turns = await resolveIntegrations(
      gateway([{ name: "searxng", config: { base_url: "http://searx.test" }, enabled: true }]),
      "org-1",
    );
    expect(turns).toHaveLength(1);
    const tool = turns[0]!.tools.find((t) => t.trait === "web_search")!;
    expect(tool.spec.name).toBe("web_search");
    expect(tool.spec.description).toContain("Search the public web");
    expect(tool.raw).toBe("web_search");
  });

  it("are provided by one integration only, first in catalog order", async () => {
    const turns = await resolveIntegrations(
      gateway([
        { name: "searxng", config: { base_url: "http://searx.test" }, enabled: true },
        { name: "firecrawl", config: {}, enabled: true },
      ]),
      "org-1",
    );
    const searx = turns.find((t) => t.slug === "searxng")!;
    const firecrawl = turns.find((t) => t.slug === "firecrawl")!;
    expect(searx.tools.map((t) => t.spec.name)).toContain("web_search");
    // firecrawl keeps its own tools but loses the trait the earlier
    // integration provides.
    expect(firecrawl.tools.map((t) => t.spec.name)).not.toContain("web_search");
    expect(firecrawl.tools.map((t) => t.spec.name)).toContain("firecrawl_map");
  });

  it("name the provider's raw tool for dispatch", async () => {
    const turns = await resolveIntegrations(gateway([{ name: "firecrawl", config: {}, enabled: true }]), "org-1");
    const trait = turns[0]!.tools.find((t) => t.trait === "web_fetch")!;
    expect(trait.spec.name).toBe("web_fetch");
    expect(trait.raw).toBe("web_fetch");
  });
});

describe("grafana execute", () => {
  let server: Server;
  let base = "";
  const calls: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls.push(`${req.method ?? "GET"} ${req.url ?? ""}`);
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (url === "/api/health") {
        res.end(JSON.stringify({ database: "ok", version: "12.3.0" }));
        return;
      }
      if (url.startsWith("/api/datasources/uid/PROM1") && !url.includes("/resources/")) {
        res.end(JSON.stringify({ uid: "PROM1", name: "Prometheus", type: "prometheus" }));
        return;
      }
      if (url.startsWith("/api/datasources/uid/LOKI1") && !url.includes("/proxy/")) {
        res.end(JSON.stringify({ uid: "LOKI1", name: "Loki", type: "loki" }));
        return;
      }
      if (url.startsWith("/api/datasources/uid/PROM1/resources/api/v1/query")) {
        res.end(
          JSON.stringify({
            status: "success",
            data: { resultType: "vector", result: [{ metric: { job: "api" }, value: [1, "42"] }] },
          }),
        );
        return;
      }
      if (url.startsWith("/api/datasources/proxy/uid/LOKI1/loki/api/v1/query_range")) {
        res.end(
          JSON.stringify({
            status: "success",
            data: {
              resultType: "streams",
              result: [{ stream: { app: "api" }, values: [["1700000000000000000", "boom"]] }],
            },
          }),
        );
        return;
      }
      if (url.startsWith("/api/alertmanager/grafana/api/v2/alerts")) {
        res.end(
          JSON.stringify([
            {
              labels: { alertname: "HighLatency", severity: "warning" },
              annotations: { summary: "p95 over 2s" },
              startsAt: "2026-10-26T10:00:00Z",
            },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const config = () => ({ base_url: base, prometheus_datasource: "PROM1", loki_datasource: "LOKI1" });

  it("queries metrics through the named datasource", async () => {
    const out = await grafanaExecute(config(), "query_metrics", { query: "up" }, SECRETS, null);
    expect(out.content).toContain("datasource=Prometheus (PROM1)");
    expect(out.content).toContain('job="api"');
    expect(out.content).toContain("42");
    expect(calls.some((c) => c.includes("/api/datasources/uid/PROM1/resources/api/v1/query"))).toBe(true);
  });

  it("queries logs through the datasource proxy", async () => {
    const out = await grafanaExecute(config(), "query_logs", { query: '{app="api"}' }, SECRETS, null);
    expect(out.content).toContain("datasource=Loki (LOKI1)");
    expect(out.content).toContain("boom");
  });

  it("lists the active alerts", async () => {
    const out = await grafanaExecute(config(), "list_alerts", {}, SECRETS, null);
    expect(out.content).toContain("[warning] HighLatency");
    expect(out.content).toContain("p95 over 2s");
  });

  it("reports a missing datasource instead of guessing", async () => {
    await expect(
      grafanaExecute(config(), "query_metrics", { query: "up", datasource: "Nope" }, SECRETS, null),
    ).rejects.toThrow(/datasource "Nope" not found/);
  });

  it("refuses a datasource of the wrong type", async () => {
    await expect(
      grafanaExecute(config(), "query_metrics", { query: "up", datasource: "LOKI1" }, SECRETS, null),
    ).rejects.toThrow(/not prometheus/);
  });
});
