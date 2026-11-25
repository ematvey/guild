// Admin routes for installing integration plugins: the org's catalogs (add,
// remove, browse with install state), install from a catalog, from an
// uploaded .guildplugin, or from a bundle URL, and the org's trait
// bindings (which integration answers web_search, web_fetch, …).

import type { FastifyInstance } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import type { UserRow } from "../store/identity.js";
import { ApiError } from "../errors.js";
import { bodyBytes, pathParam, queryParam, requireAdminUser, requireJsonBody, sendJson } from "./error.js";
import { bundleSha256, type Publisher } from "../registry-publish.js";
import { traitNames, traitSpec } from "@guild/integration-sdk";
import {
  BUNDLE_MAX_BYTES,
  CatalogError,
  describeSource,
  fetchBundleUrl,
  fetchCatalogBundle,
  listCatalogs,
  parseCatalogConfig,
  previewCatalogBundle,
  readIndex,
  saveCatalogs,
  type CatalogConfig,
  type CatalogDeps,
} from "../../integrations/catalogs.js";
import { installPluginBundle, type InstallOrigin, type PluginInstallDeps } from "../../integrations/plugin-install.js";
import { orgConnectors, readTraitBindings, writeTraitBinding } from "../../integrations/connectors.js";
import { isBuiltinSlug } from "../../integrations/loader.js";

function publisherOf(admin: UserRow): Publisher {
  return {
    orgId: admin.org_id,
    userId: admin.id,
    role: admin.role,
    label: admin.display_name && admin.display_name !== "" ? admin.display_name : admin.email,
  };
}

/** Orders two version strings: numeric dot segments compare as numbers,
 *  anything else as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function catalogError(error: unknown): never {
  if (error instanceof CatalogError) throw ApiError.badRequest(error.message);
  throw error;
}

export function registerPluginCatalogRoutes(app: FastifyInstance, gateway: GatewayCtx, identity: IdentityCtx): void {
  const catalogDeps: CatalogDeps = {
    orgKv: identity.orgKv,
    integrations: gateway.integrations,
    integrationSecrets: gateway.integrationSecrets,
    masterKey: () => gateway.masterKey(),
  };
  const installDeps: PluginInstallDeps = {
    integrations: gateway.integrations,
    registry: gateway.registry,
    teams: identity.teams,
    events: identity.events,
    objects: gateway.objects,
  };

  async function install(admin: UserRow, bytes: Buffer, origin: InstallOrigin) {
    return installPluginBundle(installDeps, publisherOf(admin), bytes, origin);
  }

  async function catalogById(orgId: string, id: string): Promise<CatalogConfig> {
    const found = (await listCatalogs(identity.orgKv, orgId)).find((c) => c.id === id);
    if (found === undefined) throw ApiError.notFound("unknown catalog");
    return found;
  }

  // Every catalog of the org with its plugins and this org's install state
  // per plugin. A catalog that cannot be read reports its error in place.
  app.get("/api/v1/admin/integrations/catalogs", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const refresh = queryParam(req, "refresh") === "1";
    const catalogs = await listCatalogs(identity.orgKv, admin.org_id);
    const out = await Promise.all(
      catalogs.map(async (catalog) => {
        const base = {
          id: catalog.id,
          name: catalog.name,
          source: catalog.source,
          label: describeSource(catalog.source),
        };
        let index;
        try {
          index = await readIndex(catalogDeps, admin.org_id, catalog, refresh);
        } catch (error) {
          return { ...base, error: (error as Error).message, plugins: [] };
        }
        const plugins = await Promise.all(
          index.plugins.map(async (p) => {
            // Installed means the org has an instance of the kind; an
            // approved bundle left behind by a removed integration installs
            // again. The catalog slug is the kind, never an instance slug.
            const [approved, row] = await Promise.all([
              gateway.registry.approvedBundle(admin.org_id, "integration", p.slug),
              gateway.integrations.firstOfKind(admin.org_id, p.slug),
            ]);
            const latest = p.versions[0]!;
            const installed = row === null ? null : (approved?.[0] ?? null);
            return {
              ...p,
              latest: latest.version,
              installed_version: installed,
              installed_sha256: approved?.[1] ?? null,
              update_available: installed !== null && compareVersions(latest.version, installed) > 0,
              builtin: isBuiltinSlug(p.slug),
            };
          }),
        );
        return { ...base, name: index.name || catalog.name, error: null, plugins };
      }),
    );
    sendJson(reply, { catalogs: out });
    return reply;
  });

  // Adds a catalog: the source must already serve a readable index.
  app.post("/api/v1/admin/integrations/catalogs", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    let catalog: CatalogConfig;
    try {
      catalog = parseCatalogConfig(requireJsonBody(req));
    } catch (error) {
      catalogError(error);
    }
    const list = await listCatalogs(identity.orgKv, admin.org_id);
    if (list.some((c) => JSON.stringify(c.source) === JSON.stringify(catalog.source))) {
      throw ApiError.conflict("catalog_exists", "this catalog is already added");
    }
    let name = catalog.name;
    try {
      const index = await readIndex(catalogDeps, admin.org_id, catalog, true);
      if (requireJsonBody(req)["name"] === undefined || requireJsonBody(req)["name"] === "") name = index.name;
    } catch (error) {
      catalogError(error);
    }
    const saved = { ...catalog, name };
    await saveCatalogs(identity.orgKv, admin.org_id, [...list, saved]);
    sendJson(reply, { catalog: saved });
    return reply;
  });

  app.delete("/api/v1/admin/integrations/catalogs/:id", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = pathParam(req, "id");
    const list = await listCatalogs(identity.orgKv, admin.org_id);
    if (!list.some((c) => c.id === id)) throw ApiError.notFound("unknown catalog");
    await saveCatalogs(
      identity.orgKv,
      admin.org_id,
      list.filter((c) => c.id !== id),
    );
    sendJson(reply, {});
    return reply;
  });

  // Installs (or updates to) one catalog version: the bundle must match the
  // sha256 the index lists. No version = the newest.
  app.post("/api/v1/admin/integrations/catalogs/:id/install", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const catalog = await catalogById(admin.org_id, pathParam(req, "id"));
    const body = requireJsonBody(req);
    const slug = typeof body["slug"] === "string" ? body["slug"] : "";
    const wanted = typeof body["version"] === "string" && body["version"] !== "" ? body["version"] : null;
    let bytes: Buffer;
    try {
      const index = await readIndex(catalogDeps, admin.org_id, catalog, true);
      const plugin = index.plugins.find((p) => p.slug === slug);
      if (plugin === undefined) throw ApiError.notFound(`the catalog has no plugin ${slug}`);
      const version = wanted === null ? plugin.versions[0]! : plugin.versions.find((v) => v.version === wanted);
      if (version === undefined) throw ApiError.notFound(`the catalog has no ${slug} ${wanted}`);
      bytes = await fetchCatalogBundle(catalogDeps, admin.org_id, catalog, version, bundleSha256);
    } catch (error) {
      catalogError(error);
    }
    const installed = await install(admin, bytes, { kind: "catalog", catalog: describeSource(catalog.source) });
    if (installed.slug !== slug) {
      throw ApiError.badRequest(`the bundle declares slug ${installed.slug}, the catalog ${slug}`);
    }
    sendJson(reply, installed);
    return reply;
  });

  // One catalog plugin's landing page: the index entry with this org's
  // install state, and the chosen version's bundle content (manifest,
  // README, logo) read without installing or running it.
  app.get("/api/v1/admin/integrations/catalogs/:id/plugins/:slug", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const catalog = await catalogById(admin.org_id, pathParam(req, "id"));
    const slug = pathParam(req, "slug");
    const wanted = queryParam(req, "version") ?? null;
    let body: Record<string, unknown>;
    try {
      const index = await readIndex(catalogDeps, admin.org_id, catalog, false);
      const plugin = index.plugins.find((p) => p.slug === slug);
      if (plugin === undefined) throw ApiError.notFound(`the catalog has no plugin ${slug}`);
      const version = wanted === null ? plugin.versions[0]! : plugin.versions.find((v) => v.version === wanted);
      if (version === undefined) throw ApiError.notFound(`the catalog has no ${slug} ${wanted}`);
      const preview = await previewCatalogBundle(catalogDeps, admin.org_id, catalog, version, bundleSha256);
      const [approved, row] = await Promise.all([
        gateway.registry.approvedBundle(admin.org_id, "integration", slug),
        gateway.integrations.firstOfKind(admin.org_id, slug),
      ]);
      body = {
        catalog: { id: catalog.id, name: index.name || catalog.name, label: describeSource(catalog.source) },
        plugin: {
          ...plugin,
          latest: plugin.versions[0]!.version,
          installed_version: row === null ? null : (approved?.[0] ?? null),
          builtin: isBuiltinSlug(slug),
        },
        version: { ...version },
        manifest: preview.manifest,
        readme: preview.readme,
        logo: preview.logo,
      };
    } catch (error) {
      catalogError(error);
    }
    sendJson(reply, body);
    return reply;
  });

  // Installs an uploaded .guildplugin (the request body is the bundle).
  app.post("/api/v1/admin/integrations/plugins/upload", { bodyLimit: BUNDLE_MAX_BYTES }, async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const bytes = bodyBytes(req);
    if (bytes.length === 0) throw ApiError.badRequest("empty bundle");
    sendJson(reply, await install(admin, bytes, { kind: "upload" }));
    return reply;
  });

  // Installs a bundle from a URL; an optional sha256 must match.
  app.post("/api/v1/admin/integrations/plugins/url", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const body = requireJsonBody(req);
    const url = typeof body["url"] === "string" ? body["url"].trim() : "";
    const expected = typeof body["sha256"] === "string" ? body["sha256"].trim().toLowerCase() : "";
    let bytes: Buffer;
    try {
      bytes = await fetchBundleUrl(url);
    } catch (error) {
      catalogError(error);
    }
    if (expected !== "" && bundleSha256(bytes) !== expected) {
      throw ApiError.badRequest("the downloaded bundle does not match the given sha256");
    }
    sendJson(reply, await install(admin, bytes, { kind: "url", url }));
    return reply;
  });

  // The org's traits: each with its bound provider and every connector that
  // declares it (with whether the org has it enabled).
  app.get("/api/v1/admin/integrations/traits", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const [connectors, rows, bindings] = await Promise.all([
      orgConnectors(gateway, admin.org_id),
      gateway.integrations.list(admin.org_id),
      readTraitBindings(identity.orgKv, admin.org_id),
    ]);
    const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.name));
    const traits = traitNames().map((name) => {
      const providers = connectors
        .filter((c) => c.traits[name] !== undefined)
        .map((c) => ({ slug: c.name, title: c.title, enabled: enabled.has(c.name) }));
      const firstEnabled = providers.find((p) => p.enabled)?.slug ?? null;
      const bound = bindings[name] ?? null;
      const active = bound !== null && providers.some((p) => p.slug === bound && p.enabled) ? bound : firstEnabled;
      return { name, description: traitSpec(name)?.description ?? "", provider: bound, active, providers };
    });
    sendJson(reply, { traits });
    return reply;
  });

  app.put("/api/v1/admin/integrations/traits/:trait", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const trait = pathParam(req, "trait");
    if (!traitNames().includes(trait)) throw ApiError.notFound(`unknown trait ${trait}`);
    const body = requireJsonBody(req);
    const provider = typeof body["provider"] === "string" && body["provider"] !== "" ? body["provider"] : null;
    if (provider !== null) {
      const connectors = await orgConnectors(gateway, admin.org_id);
      if (!connectors.some((c) => c.name === provider && c.traits[trait] !== undefined)) {
        throw ApiError.badRequest(`${provider} does not provide ${trait}`);
      }
    }
    const bindings = await writeTraitBinding(identity.orgKv, admin.org_id, trait, provider);
    sendJson(reply, { bindings });
    return reply;
  });
}
