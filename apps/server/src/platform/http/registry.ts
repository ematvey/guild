// Registry API: publish, list, versions, review, download, install
// (crates/server/src/http/registry.rs). Bundles are tar.gz; bytes live in
// object storage, metadata in Postgres. Server-side install creates a
// disabled routine (v1 automation bundle) or a disabled MCP-plugin
// integration row + trigger routines (v2) — both stay inert until enabled,
// which the deferred routines feature never does (spec decision 8).

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PlatformContext } from "../context.js";
import { ApiError, requireUser } from "./error.js";
import { rustJsonText } from "../provider/sse.js";
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
 *  overwritten in place. */
function objectKey(orgId: string, kind: string, slug: string, version: string, sha256: string): string {
  return `registry/${orgId}/${kind}/${slug}/${version}/${sha256}.tar.gz`;
}

function sha256Hex(data: Buffer): string {
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

export function registerRegistryRoutes(app: FastifyInstance, ctx: PlatformContext): void {
  app.post("/api/v1/registry/:kind", async (req, reply) => {
    const user = await requireUser(ctx, req);
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

    const sha256 = sha256Hex(body);
    const key = objectKey(user.org_id, kind, slug, version, sha256);

    // Metadata first: only an accepted upsert (new version, unchanged
    // republish) commits a row — a superseded publish is refused before any
    // bundle bytes land, so the old release's object stays intact.
    await ctx.registry.upsertVersion(
      user.org_id,
      kind,
      slug,
      version,
      typeof manifest.description === "string" ? manifest.description : "",
      manifest,
      key,
      sha256,
      user.id,
    );
    // The content-addressed key was accepted by upsertVersion; the bytes
    // are immutable and idempotent to re-write, so a failed put only leaves
    // the object missing until the publish is retried.
    try {
      await ctx.objects.put(key, body);
    } catch (error) {
      throw ApiError.internal(`object store write failed: ${(error as Error).message}`);
    }
    // org event: registry item published; best-effort
    try {
      await ctx.events.emit(user.org_id, "registry.published", { kind, slug, version });
    } catch {
      // best-effort
    }
    sendJson(reply, { slug, version });
    return reply;
  });

  app.get("/api/v1/registry/:kind", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const kind = param(req, "kind");
    validKind(kind);
    const items = await ctx.registry.listItems(user.org_id, kind);
    sendJson(reply, { items });
    return reply;
  });

  app.get("/api/v1/registry/:kind/:slug", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const kind = param(req, "kind");
    validKind(kind);
    const versions = await ctx.registry.itemVersions(user.org_id, kind, param(req, "slug"));
    sendJson(reply, { versions });
    return reply;
  });

  app.get("/api/v1/registry/:kind/:slug/:version/bundle", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const kind = param(req, "kind");
    validKind(kind);
    const slug = param(req, "slug");
    const version = param(req, "version");
    const stored = await ctx.registry.getVersion(user.org_id, kind, slug, version);
    // members can only download the exact approved bundle: the requested
    // version must be the approval's version and its stored hash must equal
    // the approved one — a byte-swapped republish is undownloadable.
    if (user.role !== "admin") {
      const approved = await ctx.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null || approved[0] !== version || stored.bundle_sha256 !== approved[1]) {
        throw ApiError.forbidden();
      }
    }
    let bytes: Buffer;
    try {
      bytes = await ctx.objects.get(stored.object_key);
    } catch (error) {
      throw ApiError.internal(`object store read failed: ${(error as Error).message}`);
    }
    return reply.status(200).type("application/gzip").send(bytes);
  });

  app.post("/api/v1/registry/:kind/:slug/review", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
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
    await ctx.registry.setReview(admin.org_id, kind, slug, status, reviewedVersion, reviewedBundleSha256);
    sendJson(reply, {});
    return reply;
  });

  app.post("/api/v1/registry/:kind/:slug/install", async (req, reply) => {
    const user = await requireUser(ctx, req);
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
      const approved = await ctx.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null) throw ApiError.forbidden();
      version = approved[0];
    }
    const stored = await ctx.registry.getVersion(user.org_id, kind, slug, version);
    // Members can only install the exact approved bundle (admins keep the
    // review-surface bypass).
    if (user.role !== "admin") {
      const approved = await ctx.registry.approvedBundle(user.org_id, kind, slug);
      if (approved === null || approved[0] !== version || stored.bundle_sha256 !== approved[1]) {
        throw ApiError.forbidden();
      }
    }
    let bytes: Buffer;
    try {
      bytes = await ctx.objects.get(stored.object_key);
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
      return installMcpPlugin(ctx, reply, user, slug, manifest, parsed);
    }
    const routineJson = readBundleFile(parsed, "routine.json");
    if (routineJson === null) throw ApiError.badRequest("bundle has no routine.json");
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(routineJson.toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      throw ApiError.badRequest(`bad routine.json: ${(error as Error).message}`);
    }
    const triggerKind = typeof cfg["trigger_kind"] === "string" ? cfg["trigger_kind"] : "webhook";
    if (triggerKind !== "webhook" && triggerKind !== "interval") {
      throw ApiError.badRequest("routine.json trigger_kind must be webhook or interval");
    }
    if (typeof cfg["prompt"] !== "string") throw ApiError.badRequest("routine.json missing prompt");
    if (typeof cfg["model"] !== "string") throw ApiError.badRequest("routine.json missing model");
    const webhookToken = newHookToken();
    const allowedTools = cfg["allowed_tools"] ?? ["http_call", "storage_put"];
    const routine = await ctx.routines.create(
      user.org_id,
      user.id,
      slug,
      typeof cfg["name"] === "string" ? cfg["name"] : slug,
      triggerKind,
      cfg["trigger_config"] ?? {},
      cfg["prompt"] as string,
      cfg["model"] as string,
      allowedTools,
      webhookToken,
      false, // disabled until the owner enables it
    );
    // The plaintext webhook token is shown once, at install; only its hash
    // is stored (same shape as the routines create endpoint).
    const routineValue: Record<string, unknown> = { ...routine };
    if (routine.trigger_kind === "webhook") {
      routineValue["webhook_token"] = webhookToken;
    }
    sendJson(reply, { routine: routineValue });
    return reply;
  });
}

/** Install path for v2 MCP plugin bundles: creates a disabled `integrations`
 *  row carrying the mcp/auth/tool_policy config (skipped when the row
 *  already exists) and disabled routines from the manifest triggers. */
async function installMcpPlugin(
  ctx: PlatformContext,
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
  const existing = (await ctx.integrations.list(user.org_id)).find((r) => r.name === slug);
  let integrationRow = existing ?? null;
  if (integrationRow === null) {
    await ctx.integrations.upsert(user.org_id, slug, config, false);
    integrationRow = (await ctx.integrations.list(user.org_id)).find((r) => r.name === slug) ?? null;
    if (integrationRow === null) throw ApiError.internal("row just upserted");
  }

  const triggers = Array.isArray(manifest.triggers) ? manifest.triggers : [];
  const routines: Record<string, unknown>[] = [];
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i] as Record<string, unknown>;
    const routineSlug = i === 0 ? slug : `${slug}-${i}`;
    if ((await ctx.routines.getBySlug(user.org_id, routineSlug)) !== null) {
      continue;
    }
    const allowedTools = t["allowed_tools"] ?? ["http_call", "storage_put"];
    if (typeof t["prompt"] !== "string" || typeof t["model"] !== "string") {
      throw ApiError.badRequest("trigger prompt is empty");
    }
    const webhookToken = newHookToken();
    const routine = await ctx.routines.create(
      user.org_id,
      user.id,
      routineSlug,
      typeof t["name"] === "string" ? t["name"] : slug,
      typeof t["kind"] === "string" ? t["kind"] : "webhook",
      t["trigger_config"] ?? {},
      t["prompt"] as string,
      t["model"] as string,
      allowedTools,
      webhookToken,
      false, // disabled until an admin enables it
    );
    // The plaintext token is shown once here: only its hash is stored and
    // no rotate endpoint exists, so dropping it would leave the webhook
    // trigger permanently unusable.
    routines.push({ ...routine, webhook_token: webhookToken });
  }
  sendJson(reply, { integration: integrationRow, routines });
  return reply;
}

function param(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string>)[name] ?? "";
}

async function requireAdmin(ctx: PlatformContext, req: FastifyRequest): Promise<UserRow> {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw ApiError.forbidden();
  return user;
}
