// Installing integration plugins over the admin API: an uploaded code
// bundle lands in the org's registry approved and serves as a connector;
// catalogs (a public URL, a private GitHub repository read through the
// org's GitHub integration) list plugins with install state and install by
// the sha256 they list; trait bindings pick the provider.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObjectStoreStack, type ObjectStoreStack } from "./support/object-store-stack.js";
import { fixtureBundle } from "./support/code-plugin-fixture.js";
import { compareVersions } from "../platform/http/plugin-catalogs.js";

const PASSWORD = "hunter227";

let env: ObjectStoreStack;
let token: string;
let memberToken: string;
let files: Server;
let filesBase: string;
/** Paths the fake file host served, and the authorization each carried. */
const served: { url: string; auth: string | undefined }[] = [];
const hosted = new Map<string, Buffer | string>();

function index(entries: { slug: string; versions: { version: string; sha256: string; bundle: string }[] }[]): string {
  return JSON.stringify({
    format: "guild-plugin-catalog/1",
    name: "Acme plugins",
    plugins: entries.map((e) => ({
      slug: e.slug,
      title: `Acme ${e.slug}`,
      summary: "test",
      publisher: "Acme",
      categories: [],
      traits: ["web_search"],
      versions: e.versions,
    })),
  });
}

async function api(method: string, url: string, body?: unknown, as = token) {
  const headers: Record<string, string> = { authorization: `Bearer ${as}` };
  let payload: string | Buffer | undefined;
  if (Buffer.isBuffer(body)) {
    headers["content-type"] = "application/gzip";
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await env.app.inject({ method: method as "GET", url, headers, payload });
  return { status: res.statusCode, body: res.body === "" ? {} : (JSON.parse(res.body) as Record<string, any>) };
}

beforeAll(async () => {
  env = await createObjectStoreStack("error", {}, "plugins");
  const orgId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const { hashPassword } = await import("../platform/crypto.js");
  const hash = await hashPassword(PASSWORD);
  await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'plugins org')", [orgId]);
  await env.db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES " +
      "($1, $2, $3, $4, 'admin', 'managed'), ($5, $2, $6, $4, 'member', 'managed')",
    [crypto.randomUUID(), orgId, `pa-${suffix}@example.test`, hash, crypto.randomUUID(), `pm-${suffix}@example.test`],
  );
  const login = async (email: string) => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: PASSWORD },
    });
    return (JSON.parse(res.body) as { token: string }).token;
  };
  token = await login(`pa-${suffix}@example.test`);
  memberToken = await login(`pm-${suffix}@example.test`);

  // One fake host plays a static catalog site and the GitHub API.
  files = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    served.push({ url, auth: req.headers["authorization"] as string | undefined });
    if (url === "/gh/user") {
      res.writeHead(req.headers["authorization"] === "Bearer gh-token" ? 200 : 401);
      res.end("{}");
      return;
    }
    if (url.startsWith("/gh/repos/")) {
      if (
        req.headers["authorization"] !== "Bearer gh-token" ||
        req.headers["accept"] !== "application/vnd.github.raw"
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      const m = /^\/gh\/repos\/acme\/private-plugins\/contents\/([^?]+)/.exec(url);
      const body = m === null ? undefined : hosted.get(`gh:${decodeURIComponent(m[1]!)}`);
      res.writeHead(body === undefined ? 404 : 200);
      res.end(body ?? "");
      return;
    }
    const body = hosted.get(url);
    res.writeHead(body === undefined ? 404 : 200);
    res.end(body ?? "");
  });
  await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
  filesBase = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => files.close(() => resolve()));
  await env.cleanup();
});

describe("uploaded code plugins", () => {
  it("install approved, show in the shop, and save through the plugin's own connection test", async () => {
    const { bytes } = fixtureBundle("acme-upload", "1.0.0");
    const up = await api("POST", "/api/v1/admin/integrations/plugins/upload", bytes);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ slug: "acme-upload", version: "1.0.0", runtime: "code", created: true });

    const shop = await api("GET", "/api/v1/admin/integrations");
    const item = shop.body.items.find((i: { name: string }) => i.name === "acme-upload");
    expect(item).toMatchObject({ source: "registry", configured: true, enabled: false, logo: "<svg/>" });
    expect(item.secret_names).toEqual(["token"]);

    const bad = await api("PUT", `/api/v1/admin/integrations/${item.id}`, {
      config: { greeting: "hey" },
      secrets: { token: "nope" },
      enabled: true,
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("acme rejected the token");
    const ok = await api("PUT", `/api/v1/admin/integrations/${item.id}`, {
      config: { greeting: "hey" },
      secrets: { token: "good" },
      enabled: true,
    });
    expect(ok.status).toBe(200);

    const tools = await api("GET", `/api/v1/admin/integrations/${item.id}/tools`);
    expect(tools.body.kind).toBe("connector");
    expect(tools.body.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "search", "hang", "crash"]);
  });

  it("are refused when they reuse a built-in slug or do not start", async () => {
    const clash = fixtureBundle("github", "1.0.0");
    expect((await api("POST", "/api/v1/admin/integrations/plugins/upload", clash.bytes)).status).toBe(409);
    const broken = fixtureBundle("acme-broken", "1.0.0", { source: "export default {};" });
    const res = await api("POST", "/api/v1/admin/integrations/plugins/upload", broken.bytes);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("failed to start");
  });

  it("are admin-only", async () => {
    const { bytes } = fixtureBundle("acme-member", "1.0.0");
    const res = await api("POST", "/api/v1/admin/integrations/plugins/upload", bytes, memberToken);
    expect(res.status).toBe(403);
  });
});

describe("catalogs", () => {
  it("list a public index with install state and install by the listed sha256", async () => {
    const v1 = fixtureBundle("acme-cat", "1.0.0");
    const v2 = fixtureBundle("acme-cat", "1.1.0");
    hosted.set("/cat/bundles/acme-cat-1.0.0.guildplugin", v1.bytes);
    hosted.set("/cat/bundles/acme-cat-1.1.0.guildplugin", v2.bytes);
    hosted.set(
      "/cat/index.json",
      index([
        {
          slug: "acme-cat",
          versions: [
            { version: "1.1.0", sha256: v2.sha256, bundle: "bundles/acme-cat-1.1.0.guildplugin" },
            { version: "1.0.0", sha256: v1.sha256, bundle: "bundles/acme-cat-1.0.0.guildplugin" },
          ],
        },
      ]),
    );
    const added = await api("POST", "/api/v1/admin/integrations/catalogs", {
      source: { kind: "url", url: `${filesBase}/cat/index.json` },
    });
    expect(added.status).toBe(200);
    expect(added.body.catalog.name).toBe("Acme plugins");
    const id = added.body.catalog.id as string;

    const dup = await api("POST", "/api/v1/admin/integrations/catalogs", {
      source: { kind: "url", url: `${filesBase}/cat/index.json` },
    });
    expect(dup.status).toBe(409);

    const old = await api("POST", `/api/v1/admin/integrations/catalogs/${id}/install`, {
      slug: "acme-cat",
      version: "1.0.0",
    });
    expect(old.status).toBe(200);
    let list = await api("GET", "/api/v1/admin/integrations/catalogs");
    let entry = list.body.catalogs[0].plugins[0];
    expect(entry).toMatchObject({
      slug: "acme-cat",
      latest: "1.1.0",
      installed_version: "1.0.0",
      update_available: true,
    });

    const latest = await api("POST", `/api/v1/admin/integrations/catalogs/${id}/install`, { slug: "acme-cat" });
    expect(latest.body.version).toBe("1.1.0");
    expect(latest.body.created).toBe(false);
    list = await api("GET", "/api/v1/admin/integrations/catalogs");
    entry = list.body.catalogs[0].plugins[0];
    expect(entry).toMatchObject({ installed_version: "1.1.0", update_available: false });

    // Removing the integration leaves the approved bundle; the catalog lists
    // the plugin as not installed and installs it again.
    const shop = await api("GET", "/api/v1/admin/integrations");
    const row = (shop.body.items as { name: string; id: string | null }[]).find((i) => i.name === "acme-cat");
    expect((await api("DELETE", `/api/v1/admin/integrations/${row!.id}`)).status).toBe(200);
    list = await api("GET", "/api/v1/admin/integrations/catalogs");
    entry = list.body.catalogs[0].plugins[0];
    expect(entry).toMatchObject({ installed_version: null, update_available: false });
    const again = await api("POST", `/api/v1/admin/integrations/catalogs/${id}/install`, { slug: "acme-cat" });
    expect(again.body.created).toBe(true);
  });

  it("refuse a bundle that does not match the listed sha256", async () => {
    const real = fixtureBundle("acme-tamper", "1.0.0");
    hosted.set("/tamper/b.guildplugin", fixtureBundle("acme-tamper", "1.0.0", { source: "export default 1;" }).bytes);
    hosted.set(
      "/tamper/index.json",
      index([{ slug: "acme-tamper", versions: [{ version: "1.0.0", sha256: real.sha256, bundle: "b.guildplugin" }] }]),
    );
    const added = await api("POST", "/api/v1/admin/integrations/catalogs", {
      source: { kind: "url", url: `${filesBase}/tamper/index.json` },
    });
    const res = await api("POST", `/api/v1/admin/integrations/catalogs/${added.body.catalog.id}/install`, {
      slug: "acme-tamper",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("does not match the sha256");
  });

  it("read a private GitHub repository through the org's GitHub integration", async () => {
    const bundle = fixtureBundle("acme-gh", "2.0.0");
    hosted.set(
      "gh:plugins/index.json",
      index([
        {
          slug: "acme-gh",
          versions: [{ version: "2.0.0", sha256: bundle.sha256, bundle: "bundles/acme-gh.guildplugin" }],
        },
      ]),
    );
    hosted.set("gh:plugins/bundles/acme-gh.guildplugin", bundle.bytes);
    const source = { kind: "github", repo: "acme/private-plugins", path: "plugins/index.json" };

    const before = await api("POST", "/api/v1/admin/integrations/catalogs", { source });
    expect(before.status).toBe(400);
    expect(JSON.stringify(before.body)).toContain("configure it first");

    const gh = await api("POST", "/api/v1/admin/integrations", {
      name: "github",
      config: { api_url: `${filesBase}/gh` },
      secrets: { token: "gh-token" },
      enabled: true,
    });
    expect(gh.status).toBe(200);
    const added = await api("POST", "/api/v1/admin/integrations/catalogs", { source, name: "Private" });
    expect(added.status).toBe(200);
    expect(added.body.catalog.name).toBe("Private");
    const res = await api("POST", `/api/v1/admin/integrations/catalogs/${added.body.catalog.id}/install`, {
      slug: "acme-gh",
    });
    expect(res.status).toBe(200);
    expect(
      served.some(
        (s) => s.url.includes("/contents/plugins/bundles/acme-gh.guildplugin") && s.auth === "Bearer gh-token",
      ),
    ).toBe(true);
  });

  it("can be removed", async () => {
    const list = await api("GET", "/api/v1/admin/integrations/catalogs");
    const id = list.body.catalogs[0].id as string;
    expect((await api("DELETE", `/api/v1/admin/integrations/catalogs/${id}`)).status).toBe(200);
    const after = await api("GET", "/api/v1/admin/integrations/catalogs");
    expect(after.body.catalogs.map((c: { id: string }) => c.id)).not.toContain(id);
  });
});

describe("URL installs", () => {
  it("install a bundle from a URL, checking an optional sha256", async () => {
    const b = fixtureBundle("acme-url", "1.0.0");
    hosted.set("/direct/acme-url.guildplugin", b.bytes);
    const wrong = await api("POST", "/api/v1/admin/integrations/plugins/url", {
      url: `${filesBase}/direct/acme-url.guildplugin`,
      sha256: "0".repeat(64),
    });
    expect(wrong.status).toBe(400);
    const ok = await api("POST", "/api/v1/admin/integrations/plugins/url", {
      url: `${filesBase}/direct/acme-url.guildplugin`,
      sha256: b.sha256,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.slug).toBe("acme-url");
  });
});

describe("trait bindings", () => {
  it("list providers and bind one", async () => {
    const before = await api("GET", "/api/v1/admin/integrations/traits");
    const search = before.body.traits.find((t: { name: string }) => t.name === "web_search");
    expect(search.providers.map((p: { slug: string }) => p.slug)).toEqual(
      expect.arrayContaining(["searxng", "firecrawl", "acme-upload"]),
    );
    expect(search.active).toBe("acme-upload");
    const bad = await api("PUT", "/api/v1/admin/integrations/traits/web_search", { provider: "github" });
    expect(bad.status).toBe(400);
    const ok = await api("PUT", "/api/v1/admin/integrations/traits/web_search", { provider: "searxng" });
    expect(ok.body.bindings).toEqual({ web_search: "searxng" });
    const after = await api("GET", "/api/v1/admin/integrations/traits");
    const bound = after.body.traits.find((t: { name: string }) => t.name === "web_search");
    expect(bound.provider).toBe("searxng");
    // searxng is not enabled in this org, so the enabled plugin still answers.
    expect(bound.active).toBe("acme-upload");
  });
});

describe("compareVersions", () => {
  it("orders numeric segments as numbers", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9", "1.0")).toBe(-1);
  });
});
