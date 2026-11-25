// The integration shop and trait surface: the plugin manifests load, the
// trait tools take Guild-provided names and descriptions, only one
// integration provides a given trait, and the Grafana plugin speaks the
// datasource-proxy paths the real server uses.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTINS, builtinByName } from "../integrations/loader.js";
import { TRAIT_BINDINGS_KEY } from "../integrations/connectors.js";
import { resolveIntegrations } from "../integrations/plugins.js";
import { grafanaExecute } from "../integrations/grafana/execute.js";
import { posthogExecute } from "../integrations/posthog/execute.js";

const SECRETS: [string, string][] = [["token", "glsa_test"]];

function gateway(rows: { name: string; config: unknown; enabled: boolean }[], bindings: Record<string, string> = {}) {
  return {
    objects: { get: async () => Buffer.alloc(0) },
    orgKv: { get: async (_org: string, key: string) => (key === TRAIT_BINDINGS_KEY ? JSON.stringify(bindings) : null) },
    integrations: { listEnabled: async () => rows },
    integrationSecrets: {
      names: async () => [],
      resolve: async () => SECRETS,
    },
    masterKey: () => Buffer.alloc(32, 1),
    registry: {
      approvedBundle: async () => null,
      getVersion: async () => ({ manifest: {}, bundle_sha256: null, object_key: "" }),
      listItems: async () => [],
    },
  };
}

describe("integration catalog", () => {
  it("loads every plugin with a unique slug, a summary, and a logo", () => {
    const names = BUILTINS.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    for (const integration of BUILTINS) {
      expect(integration.summary).not.toBe("");
      expect(integration.description).not.toBe("");
      expect(integration.logo).toContain("<svg");
      expect(integration.tools.every((t) => ["read", "write", "admin"].includes(t.class))).toBe(true);
    }
  });

  it("ships Grafana with the observability tools", async () => {
    const grafana = builtinByName("grafana")!;
    expect(grafana.categories).toEqual(["observability"]);
    expect((await grafana.toolSpecs({ base_url: "https://grafana.example.test" })).map((t) => t.name).sort()).toEqual([
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

describe("posthog", () => {
  it("ships the project tools", async () => {
    const posthog = builtinByName("posthog")!;
    expect(posthog.categories).toEqual(["analytics"]);
    expect(
      (await posthog.toolSpecs({ base_url: "https://posthog.example.test", project_id: 7 })).map((t) => t.name).sort(),
    ).toEqual([
      "api",
      "get_dashboard",
      "get_insight",
      "list_dashboards",
      "list_feature_flags",
      "list_insights",
      "query",
      "search_persons",
    ]);
  });

  it("rejects a config without a numeric project id", async () => {
    const posthog = builtinByName("posthog")!;
    await expect(posthog.toolSpecs({ base_url: "https://posthog.example.test" })).rejects.toThrow(/project_id/);
  });
});

describe("trait tools", () => {
  it("keep the provider-prefixed name and use the Guild description", async () => {
    const turns = await resolveIntegrations(
      gateway([{ name: "searxng", config: { base_url: "http://searx.test" }, enabled: true }]),
      "org-1",
    );
    expect(turns).toHaveLength(1);
    const tool = turns[0]!.tools.find((t) => t.trait === "web_search")!;
    expect(tool.spec.name).toBe("searxng_web_search");
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
    expect(searx.tools.map((t) => t.spec.name)).toContain("searxng_web_search");
    // firecrawl keeps its own tools but loses the trait the earlier
    // integration provides.
    expect(firecrawl.tools.map((t) => t.spec.name)).not.toContain("firecrawl_web_search");
    expect(firecrawl.tools.map((t) => t.spec.name)).toContain("firecrawl_map");
  });

  it("go to the org's bound provider over the catalog order", async () => {
    const turns = await resolveIntegrations(
      gateway(
        [
          { name: "searxng", config: { base_url: "http://searx.test" }, enabled: true },
          { name: "firecrawl", config: {}, enabled: true },
        ],
        { web_search: "firecrawl" },
      ),
      "org-1",
    );
    const searx = turns.find((t) => t.slug === "searxng")!;
    const firecrawl = turns.find((t) => t.slug === "firecrawl")!;
    expect(firecrawl.tools.map((t) => t.spec.name)).toContain("firecrawl_web_search");
    expect(searx.tools.map((t) => t.spec.name)).not.toContain("searxng_web_search");
  });

  it("fall back to catalog order when the bound provider is not enabled", async () => {
    const turns = await resolveIntegrations(
      gateway([{ name: "searxng", config: { base_url: "http://searx.test" }, enabled: true }], {
        web_search: "firecrawl",
      }),
      "org-1",
    );
    expect(turns[0]!.tools.map((t) => t.spec.name)).toContain("searxng_web_search");
  });

  it("name the provider's raw tool for dispatch", async () => {
    const turns = await resolveIntegrations(gateway([{ name: "firecrawl", config: {}, enabled: true }]), "org-1");
    const trait = turns[0]!.tools.find((t) => t.trait === "web_fetch")!;
    expect(trait.spec.name).toBe("firecrawl_web_fetch");
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

describe("posthog execute", () => {
  let server: Server;
  let base = "";
  const calls: string[] = [];
  const keys: (string | undefined)[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls.push(`${req.method ?? "GET"} ${req.url ?? ""}`);
      keys.push(req.headers.authorization);
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (url === "/api/projects/7/query/") {
        res.end(JSON.stringify({ columns: ["event", "count()"], results: [["$pageview", 12]], error: null }));
        return;
      }
      if (url.startsWith("/api/projects/7/insights/?")) {
        res.end(
          JSON.stringify({
            count: 1,
            results: [{ id: 3, short_id: "abc123", name: "Signup funnel", derived_name: null }],
          }),
        );
        return;
      }
      if (url.startsWith("/api/projects/7/insights/abc123/")) {
        res.end(
          JSON.stringify({
            id: 3,
            short_id: "abc123",
            name: "Signup funnel",
            description: "signups per step",
            tags: ["growth"],
            query: { kind: "InsightVizNode", source: { kind: "FunnelsQuery" } },
          }),
        );
        return;
      }
      if (url.startsWith("/api/projects/7/dashboards/?")) {
        res.end(JSON.stringify({ count: 1, results: [{ id: 2, name: "Growth", description: "weekly growth" }] }));
        return;
      }
      if (url.startsWith("/api/projects/7/dashboards/2/")) {
        res.end(
          JSON.stringify({
            id: 2,
            name: "Growth",
            tiles: [
              { insight: { id: 3, short_id: "abc123", name: "Signup funnel" }, text: null },
              { insight: null, text: { body: "start here" } },
            ],
          }),
        );
        return;
      }
      if (url.startsWith("/api/projects/7/feature_flags/?")) {
        res.end(
          JSON.stringify({
            count: 1,
            results: [
              {
                key: "new-onboarding",
                name: "New onboarding",
                active: true,
                filters: { groups: [{ rollout_percentage: 25 }] },
              },
            ],
          }),
        );
        return;
      }
      if (url.startsWith("/api/projects/7/persons/?")) {
        res.end(
          JSON.stringify({
            results: [
              {
                uuid: "p-1",
                is_identified: true,
                last_seen_at: "2026-11-01T00:00:00Z",
                distinct_ids: ["user@example.test"],
                properties: { email: "user@example.test" },
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not found." }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const config = () => ({ base_url: base, project_id: 7 });
  const secrets: [string, string][] = [["api_key", "phx_test"]];

  it("runs a HogQL query and reads the answer as a table", async () => {
    const out = await posthogExecute(config(), "query", { query: "select event, count() from events" }, secrets, null);
    expect(out.content).toBe("event | count()\n$pageview | 12");
    expect(keys.every((k) => k === "Bearer phx_test")).toBe(true);
  });

  it("lists insights and reads one by short_id", async () => {
    const list = await posthogExecute(config(), "list_insights", { query: "signup" }, secrets, null);
    expect(list.content).toContain("Signup funnel | id=3 | short_id=abc123");
    const one = await posthogExecute(config(), "get_insight", { id: "abc123" }, secrets, null);
    expect(one.content).toContain("kind=FunnelsQuery");
    expect(one.content).toContain("tags: growth");
  });

  it("reads a dashboard with its insights", async () => {
    const out = await posthogExecute(config(), "get_dashboard", { id: 2 }, secrets, null);
    expect(out.content).toContain("Growth (id=2)");
    expect(out.content).toContain("- Signup funnel | id=3 | short_id=abc123");
    expect(out.content).toContain("text tiles: 1");
  });

  it("lists feature flags with their rollout", async () => {
    const out = await posthogExecute(config(), "list_feature_flags", {}, secrets, null);
    expect(out.content).toBe("new-onboarding | active | rollout=25% | New onboarding");
  });

  it("finds a person by search term", async () => {
    const out = await posthogExecute(config(), "search_persons", { search: "user@example.test" }, secrets, null);
    expect(out.content).toContain("user@example.test | identified");
    expect(calls.some((c) => c.includes("search=user%40example.test"))).toBe(true);
  });

  it("reports the vendor error text on a bad query", async () => {
    await expect(
      posthogExecute({ base_url: base, project_id: 9 }, "query", { query: "select 1" }, secrets, null),
    ).rejects.toThrow(/posthog 404 on \/api\/projects\/9\/query\//);
  });
});
