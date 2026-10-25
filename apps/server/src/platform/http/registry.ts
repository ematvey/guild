// Registry API: publish, list, versions, review, download, install
//. Bundles are tar.gz; bytes live in
// object storage, metadata in Postgres. Server-side install creates a
// disabled MCP-plugin integration row (routines are dropped — 2026-10-04
// decision: the feature is out of scope, automation bundles are rejected).

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import type { ObjectStore } from "../s3.js";
import { ApiError } from "../errors.js";
import { requireUser } from "./error.js";
import { rustJsonText } from "../provider/rust-json.js";
import { parseBundle, readBundleFile, type ParsedBundle } from "../bundle.js";
import { validateManifest, validateV2, type Manifest } from "../registry-manifest.js";
import type { UserRow } from "../store/identity.js";

export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

function validKind(kind: string): void {
  if (kind !== "skill" && kind !== "mcp" && kind !== "integration") {
    throw ApiError.badRequest("kind must be skill, mcp, or integration");
  }
}

/** Content-addressed: a republish with different bundle bytes lands at a
 *  new key, so superseded and supersede-attempt bundles are never
 *  overwritten in place. (Shared with the skills editor path, which
 *  re-publishes server-assembled bundles.) */
export function objectKey(orgId: string, kind: string, slug: string, version: string, sha256: string): string {
  return `registry/${orgId}/${kind}/${slug}/${version}/${sha256}.tar.gz`;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function newHookToken(): string {
  return `hook_${randomBytes(24).toString("hex")}`;
}

function queryOne(req: FastifyRequest, name: string): string | undefined {
  const url = new URL(req.url, "http://local");
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function rawBody(req: FastifyRequest): Buffer {
  const body = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.alloc(0);
}

/** json!/to_value-built responses carry serde_json's BTreeMap order — every
 *  object key sorted — and serde's number rendering. */
function sendJson(reply: FastifyReply, value: unknown): void {
  void reply.type("application/json").send(rustJsonText(value));
}

/** The shared publish body (the registry route and the skills editor both
 *  land here): content-addressed key, publish gate re-checked inside
 *  upsertVersion's FOR UPDATE transaction, SKILL.md projection for skills,
 *  object put, and the org event (first publish vs republish). */
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
  const sha256 = sha256Hex(bytes);
  const key = objectKey(user.org_id, kind, slug, version, sha256);

  // Pre-read for the team-membership input; the authoritative gate decision
  // happens inside upsertVersion's row-lock transaction.
  const control = await gateway.registry.itemControl(user.org_id, kind, slug);
  const isTeamMember =
    control?.owner_team_id != null
      ? await auth.teams.isMember(user.org_id, control.owner_team_id, user.id)
      : false;

  // Skill projection (spec §1.2/§1.3): SKILL.md text + the file list with
  // per-file hashes, stored on the version row for the panel/editor.
  let skill: { md_text: string; files: Array<{ path: string; size: number; sha256: string }> } | null = null;
  if (kind === "skill") {
    const parsed = await parseBundle(bytes);
    skill = {
      md_text: readBundleFile(parsed, "SKILL.md")!.toString("utf8"),
      files: parsed.entries
        .filter((e) => e.file)
        .map((en) => ({ path: en.path, size: en.content!.length, sha256: sha256Hex(en.content!) })),
    };
  }

  // Metadata first: only an accepted upsert (new version, unchanged
  // republish) commits a row — a superseded publish is refused before any
  // bundle bytes land, so the old release's object stays intact.
  await gateway.registry.upsertVersion(
    user.org_id,
    kind,
    slug,
    version,
    description,
    manifest,
    key,
    sha256,
    user.id,
    skill,
    { userId: user.id, role: user.role, isTeamMember },
  );
  // The content-addressed key was accepted by upsertVersion; the bytes
  // are immutable and idempotent to re-write, so a failed put only leaves
  // the object missing until the publish is retried.
  try {
    await objects.put(key, bytes);
  } catch (error) {
    throw ApiError.internal(`object store write failed: ${(error as Error).message}`);
  }
  // org event: first publish vs republish (the activity feed treats
  // them as distinct kinds); best-effort. Skill payloads carry the
  // publisher's identity (label = display name or email, matching the
  // actorLabel convention on the skill routes); mcp/integration
  // emissions keep the exact pre-fix payload shape.
  const actorPayload =
    kind === "skill"
      ? { user_id: user.id, actor: user.display_name && user.display_name !== "" ? user.display_name : user.email }
      : {};
  try {
    await auth.events.emit(
      user.org_id,
      control !== null ? "registry.updated" : "registry.published",
      { kind, slug, version, ...actorPayload },
    );
  } catch {
    // best-effort
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
    const kind = param(req, "kind");
    validKind(kind);
    const slug = queryOne(req, "slug");
    if (slug === undefined) throw ApiError.badRequest("missing slug query param");
    const version = queryOne(req, "version");
    if (version === undefined) throw ApiError.badRequest("missing version query param");
    const body = rawBody(req);
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

    await publishBundleBytes(
      gateway, auth, objects, user, kind, slug, version,
      typeof manifest.description === "string" ? manifest.description : "",
      manifest,
      body,
    );
    sendJson(reply, { slug, version });
    return reply;
  });

  app.get("/api/v1/registry/:kind", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = param(req, "kind");
    validKind(kind);
    const items = await gateway.registry.listItems(user.org_id, kind);
    sendJson(reply, { items });
    return reply;
  });

  app.get("/api/v1/registry/:kind/:slug", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = param(req, "kind");
    validKind(kind);
    const versions = await gateway.registry.itemVersions(user.org_id, kind, param(req, "slug"));
    sendJson(reply, { versions });
    return reply;
  });

  app.get("/api/v1/registry/:kind/:slug/:version/bundle", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = param(req, "kind");
    validKind(kind);
    const slug = param(req, "slug");
    const version = param(req, "version");
    const stored = await gateway.registry.getVersion(user.org_id, kind, slug, version);
    // members can only download the exact approved bundle: the requested
    // version must be the approval's version and its stored hash must equal
    // the approved one — a byte-swapped republish is undownloadable.
    // Skills are exempt (spec §1.3: no review gate — published = live), so
    // members pull any published skill version directly.
    if (kind !== "skill" && user.role !== "admin") {
      const approved = await gateway.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null || approved[0] !== version || stored.bundle_sha256 !== approved[1]) {
        throw ApiError.forbidden();
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
    const admin = await requireAdmin(auth, req);
    const kind = param(req, "kind");
    validKind(kind);
    const slug = param(req, "slug");
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
    const kind = param(req, "kind");
    validKind(kind);
    const slug = param(req, "slug");
    if (kind !== "integration") {
      throw ApiError.badRequest("only integration items are installed server-side; pull skills/mcp with the client");
    }
    // No explicit version: only an approval that still covers the latest
    // version and its exact bundle bytes yields a default.
    let version = queryOne(req, "version") ?? null;
    if (version === null) {
      const approved = await gateway.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null) throw ApiError.forbidden();
      version = approved[0];
    }
    const stored = await gateway.registry.getVersion(user.org_id, kind, slug, version);
    // Members can only install the exact approved bundle (admins keep the
    // review-surface bypass).
    if (user.role !== "admin") {
      const approved = await gateway.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null || approved[0] !== version || stored.bundle_sha256 !== approved[1]) {
        throw ApiError.forbidden();
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
    const routineJson = readBundleFile(parsed, "routine.json");
    if (routineJson !== null) {
      // Routines are dropped (2026-10-04 decision): automation bundles are
      // permanently unsupported — refuse instead of installing an inert row.
      throw ApiError.badRequest("automation bundles (routine.json) are not supported: routines are dropped");
    }
    throw ApiError.badRequest("bundle has neither an mcp plugin nor a supported payload");
  });
}

/** Install path for v2 MCP plugin bundles: creates a disabled `integrations`
 *  row carrying the mcp/auth/tool_policy config (skipped when the row
 *  already exists). Trigger routines are no longer created — routines are
 *  dropped (2026-10-04 decision). */
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
  // Rust: manifest.auth.clone().unwrap_or_default() — a missing auth block
  // becomes the default manifest (org_secret / email / no secrets).
  const authIn = (manifest.auth ?? null) as Record<string, unknown> | null;
  const auth =
    authIn === null
      ? { kind: "org_secret", secret_names: [], identity_key: "email" }
      : authIn;
  const config = {
    mcp: manifest.mcp ?? null,
    auth,
    tool_policy: {},
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

function param(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string>)[name] ?? "";
}

async function requireAdmin(ctx: IdentityCtx, req: FastifyRequest): Promise<UserRow> {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw ApiError.forbidden();
  return user;
}
