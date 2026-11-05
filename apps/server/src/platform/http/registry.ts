// Registry API: publish, list, versions, review, download, install
//. Bundles are tar.gz; bytes live in
// object storage, metadata in Postgres. Server-side install creates a
// disabled MCP-plugin integration row (routines are dropped — 2026-10-04
// decision: the feature is out of scope, automation bundles are rejected).

import type { FastifyInstance, FastifyReply } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import type { ObjectStore } from "../s3.js";
import { ApiError } from "../errors.js";
import { requireUser, requireAdminUser, queryParam, sendJson, bodyBytes, pathParam } from "./error.js";
import { parseBundle, readBundleFile, type ParsedBundle } from "../bundle.js";
import { BundleWriteError, publishRegistryBundle } from "../registry-publish.js";
import { validateManifest, validateV2, type Manifest } from "../registry-manifest.js";
import type { UserRow } from "../store/identity.js";
import { isBuiltinSlug } from "../../integrations/loader.js";
import { CODE_ENTRY } from "../../integrations/code-plugins.js";

export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

function validKind(kind: string): void {
  if (kind !== "skill" && kind !== "mcp" && kind !== "integration") {
    throw ApiError.badRequest("kind must be skill, mcp, or integration");
  }
}

/** The registry route's and the skills editor's publish: the shared
 *  publish (platform/registry-publish.ts) with an HTTP error for a failed
 *  object write. */
export async function publishBundleBytes(
  gateway: GatewayCtx,
  auth: IdentityCtx,
  objects: ObjectStore,
  user: UserRow,
  kind: string,
  slug: string,
  version: string,
  description: string,
  manifest: unknown,
  bytes: Buffer,
): Promise<void> {
  try {
    await publishRegistryBundle(
      { registry: gateway.registry, teams: auth.teams, events: auth.events, objects },
      {
        orgId: user.org_id,
        userId: user.id,
        role: user.role,
        label: user.display_name && user.display_name !== "" ? user.display_name : user.email,
      },
      { kind, slug, version, description, manifest },
      bytes,
    );
  } catch (error) {
    if (error instanceof BundleWriteError) throw ApiError.internal(error.message);
    throw error;
  }
}

export function registerRegistryRoutes(
  app: FastifyInstance,
  gateway: GatewayCtx,
  auth: IdentityCtx,
  objects: ObjectStore,
): void {
  app.post("/api/v1/registry/:kind", { bodyLimit: MAX_BUNDLE_BYTES }, async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = pathParam(req, "kind");
    validKind(kind);
    const slug = queryParam(req, "slug");
    if (slug === undefined) throw ApiError.badRequest("missing slug query param");
    const version = queryParam(req, "version");
    if (version === undefined) throw ApiError.badRequest("missing version query param");
    const body = bodyBytes(req);
    if (body.length > MAX_BUNDLE_BYTES) throw ApiError.badRequest("bundle exceeds 50 MiB");

    // parse + validate the bundle's manifest
    const parsed = await parseBundle(body);
    const manifest = parsed.manifest as unknown as Manifest;
    try {
      validateManifest(manifest);
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
    if (kind === "integration") {
      try {
        validateV2(manifest);
      } catch (error) {
        throw ApiError.badRequest((error as Error).message);
      }
    }
    if (manifest.kind !== kind) {
      throw ApiError.badRequest(`manifest kind ${String(manifest.kind)} does not match path kind ${kind}`);
    }
    if (manifest.slug !== slug) {
      throw ApiError.badRequest(`manifest slug ${String(manifest.slug)} does not match query slug ${slug}`);
    }
    if (manifest.version !== version) {
      throw ApiError.badRequest(`manifest version ${String(manifest.version)} does not match query version ${version}`);
    }
    if (kind === "skill" && !parsed.entries.some((e) => e.path === "SKILL.md" && e.file)) {
      throw ApiError.badRequest("skill bundles must contain SKILL.md at the root");
    }
    if (kind === "integration" && manifest.runtime === "code") {
      assertCodeBundle(slug, parsed);
    }

    await publishBundleBytes(
      gateway,
      auth,
      objects,
      user,
      kind,
      slug,
      version,
      typeof manifest.description === "string" ? manifest.description : "",
      manifest,
      body,
    );
    sendJson(reply, { slug, version });
    return reply;
  });

  app.get("/api/v1/registry/:kind", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = pathParam(req, "kind");
    validKind(kind);
    const items = await gateway.registry.listItems(user.org_id, kind);
    sendJson(reply, { items });
    return reply;
  });

  app.get("/api/v1/registry/:kind/:slug", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = pathParam(req, "kind");
    validKind(kind);
    const versions = await gateway.registry.itemVersions(user.org_id, kind, pathParam(req, "slug"));
    sendJson(reply, { versions });
    return reply;
  });

  app.get("/api/v1/registry/:kind/:slug/:version/bundle", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = pathParam(req, "kind");
    validKind(kind);
    const slug = pathParam(req, "slug");
    const version = pathParam(req, "version");
    const stored = await gateway.registry.getVersion(user.org_id, kind, slug, version);
    // members can only download the exact approved bundle: the requested
    // version must be the approval's version and its stored hash must equal
    // the approved one — a byte-swapped republish is undownloadable.
    // Skills are exempt (spec §1.3: no review gate — published = live), so
    // members pull any published skill version directly.
    if (kind !== "skill" && user.role !== "admin") {
      const approved = await gateway.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null || approved[0] !== version || stored.bundle_sha256 !== approved[1]) {
        throw ApiError.forbidden("only the approved version can be installed");
      }
    }
    let bytes: Buffer;
    try {
      bytes = await objects.get(stored.object_key);
    } catch (error) {
      throw ApiError.internal(`object store read failed: ${(error as Error).message}`);
    }
    return reply.status(200).type("application/gzip").send(bytes);
  });

  app.post("/api/v1/registry/:kind/:slug/review", async (req, reply) => {
    const admin = await requireAdminUser(auth, req);
    const kind = pathParam(req, "kind");
    validKind(kind);
    const slug = pathParam(req, "slug");
    const body = req.body;
    const record = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const status = record["status"];
    if (typeof status !== "string") throw ApiError.badRequest("missing status");
    if (status !== "draft" && status !== "approved") {
      throw ApiError.badRequest("status must be draft or approved");
    }
    // The approval must name the content the admin inspected: the reviewed
    // version and its bundle hash. A drift between click and commit (a
    // republish in flight) is refused, never applied.
    const reviewedVersion = typeof record["reviewed_version"] === "string" ? record["reviewed_version"] : null;
    const reviewedBundleSha256 =
      typeof record["reviewed_bundle_sha256"] === "string" ? record["reviewed_bundle_sha256"] : null;
    if (status === "approved" && (reviewedVersion === null || reviewedBundleSha256 === null)) {
      throw ApiError.badRequest("approval requires reviewed_version and reviewed_bundle_sha256");
    }
    await gateway.registry.setReview(admin.org_id, kind, slug, status, reviewedVersion, reviewedBundleSha256);
    sendJson(reply, {});
    return reply;
  });

  app.post("/api/v1/registry/:kind/:slug/install", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = pathParam(req, "kind");
    validKind(kind);
    const slug = pathParam(req, "slug");
    if (kind !== "integration") {
      throw ApiError.badRequest("only integration items are installed server-side; pull skills/mcp with the client");
    }
    // No explicit version: only an approval that still covers the latest
    // version and its exact bundle bytes yields a default.
    let version = queryParam(req, "version") ?? null;
    if (version === null) {
      const approved = await gateway.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null) throw ApiError.forbidden("no approved version to install");
      version = approved[0];
    }
    const stored = await gateway.registry.getVersion(user.org_id, kind, slug, version);
    // Members can only install the exact approved bundle (admins keep the
    // review-surface bypass).
    if (user.role !== "admin") {
      const approved = await gateway.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null || approved[0] !== version || stored.bundle_sha256 !== approved[1]) {
        throw ApiError.forbidden("only the approved version can be installed");
      }
    }
    let bytes: Buffer;
    try {
      bytes = await objects.get(stored.object_key);
    } catch (error) {
      throw ApiError.internal(`bundle read failed: ${(error as Error).message}`);
    }
    const parsed = await parseBundle(bytes);
    const manifestJson = readBundleFile(parsed, "manifest.json");
    if (manifestJson === null) throw ApiError.badRequest("bundle has no manifest.json");
    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestJson.toString("utf8")) as Manifest;
    } catch (error) {
      throw ApiError.badRequest(`bad manifest.json: ${(error as Error).message}`);
    }
    if (manifest.mcp !== null && manifest.mcp !== undefined) {
      return installMcpPlugin(gateway, reply, user, slug, manifest, parsed);
    }
    if (manifest.runtime === "code") {
      assertCodeBundle(slug, parsed);
      return installCodePlugin(gateway, reply, user, slug);
    }
    const routineJson = readBundleFile(parsed, "routine.json");
    if (routineJson !== null) {
      // Routines are dropped (2026-10-04 decision): automation bundles are
      // permanently unsupported — refuse instead of installing an inert row.
      throw ApiError.badRequest("automation bundles (routine.json) are not supported: routines are dropped");
    }
    throw ApiError.badRequest("bundle has neither an mcp plugin nor a supported payload");
  });
}

/** A code plugin bundle carries its entry file and does not reuse a
 *  built-in slug (the built-in would shadow it). */
export function assertCodeBundle(slug: string, parsed: ParsedBundle): void {
  if (isBuiltinSlug(slug)) {
    throw ApiError.conflict("slug_taken", `${slug} is the name of a built-in integration`);
  }
  if (readBundleFile(parsed, CODE_ENTRY) === null) {
    throw ApiError.badRequest(`code plugin bundles must contain ${CODE_ENTRY} at the root`);
  }
}

/** Install path for code plugin bundles: a disabled, empty integration row
 *  (skipped when the row exists); the settings page completes it. */
async function installCodePlugin(
  gateway: GatewayCtx,
  reply: FastifyReply,
  user: UserRow,
  slug: string,
): Promise<FastifyReply> {
  let row = await gateway.integrations.getByName(user.org_id, slug);
  if (row === null) {
    await gateway.integrations.upsert(user.org_id, slug, {}, false);
    row = await gateway.integrations.getByName(user.org_id, slug);
    if (row === null) throw ApiError.internal("row just upserted");
  }
  sendJson(reply, { integration: row });
  return reply;
}

/** Install path for v2 MCP plugin bundles: creates a disabled `integrations`
 *  row carrying the mcp/auth config (skipped when the row
 *  already exists). */
async function installMcpPlugin(
  gateway: GatewayCtx,
  reply: FastifyReply,
  user: UserRow,
  slug: string,
  manifest: Manifest,
  parsed: ParsedBundle,
): Promise<FastifyReply> {
  try {
    validateV2(manifest);
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
  void parsed;
  // A missing auth block becomes the default manifest (org_secret / email / no secrets).
  const authIn = (manifest.auth ?? null) as Record<string, unknown> | null;
  const auth = authIn === null ? { kind: "org_secret", secret_names: [], identity_key: "email" } : authIn;
  const config = {
    mcp: manifest.mcp ?? null,
    auth,
  };
  const existing = (await gateway.integrations.list(user.org_id)).find((r) => r.name === slug);
  let integrationRow = existing ?? null;
  if (integrationRow === null) {
    await gateway.integrations.upsert(user.org_id, slug, config, false);
    integrationRow = (await gateway.integrations.list(user.org_id)).find((r) => r.name === slug) ?? null;
    if (integrationRow === null) throw ApiError.internal("row just upserted");
  }

  const triggers = Array.isArray(manifest.triggers) ? manifest.triggers : [];
  void triggers; // trigger routines are dropped (2026-10-04 decision)
  sendJson(reply, { integration: integrationRow });
  return reply;
}
