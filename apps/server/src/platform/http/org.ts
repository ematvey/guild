// Workspace settings API: display name and
// logo of the caller's organization. The logo endpoint is public — <img>
// tags cannot send bearer tokens, and a logo is not sensitive.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityCtx } from "../contexts.js";
import type { ObjectStore } from "../s3.js";
import { ApiError, sortedJson } from "../errors.js";
import { parseUuidParam, requireJsonBody, requireUser } from "./error.js";

/** Accepted logo content types → file extension in the object key. */
const LOGO_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

function rawBody(req: FastifyRequest): Buffer {
  const body = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body === undefined || body === null) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(body));
}

export function registerOrgRoutes(app: FastifyInstance, identity: IdentityCtx, objects: ObjectStore): void {
  app.get("/api/v1/org", async (req, reply) => {
    const user = await requireUser(identity, req);
    const org = await identity.orgs.get(user.org_id);
    return reply
      .status(200)
      .send(sortedJson({ name: org.name, logo_url: org.logo_url }));
  });

  app.put("/api/v1/org", async (req, reply) => {
    const user = await requireUser(identity, req);
    requireAdminRole(user);
    const body = requireJsonBody(req);
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name === "") throw ApiError.badRequest("missing name");
    if (Buffer.byteLength(name, "utf8") > 100) {
      throw ApiError.badRequest("name too long (max 100 chars)");
    }
    await identity.orgs.setName(user.org_id, name);
    return reply.status(200).send(sortedJson({ ok: true, name }));
  });

  app.put("/api/v1/org/logo", { bodyLimit: LOGO_MAX_BYTES }, async (req, reply) => {
    const user = await requireUser(identity, req);
    requireAdminRole(user);
    const contentType = queryOne(req, "content_type") ?? "image/png";
    const ext = LOGO_TYPES.find(([ct]) => ct === contentType)?.[1];
    if (ext === undefined) {
      throw ApiError.badRequest("unsupported image type (png, jpeg, webp, gif, svg)");
    }
    const bytes = rawBody(req);
    if (bytes.length === 0) throw ApiError.badRequest("empty upload");
    if (bytes.length > LOGO_MAX_BYTES) throw ApiError.badRequest("logo too large (max 2 MiB)");
    const key = `orgs/${user.org_id}/logo.${ext}`;
    try {
      await objects.put(key, bytes);
    } catch (error) {
      throw ApiError.internal(`object store write failed: ${(error as Error).message}`);
    }
    const url = `/api/v1/orgs/${user.org_id}/logo`;
    await identity.orgs.setLogoUrl(user.org_id, url);
    return reply.status(200).send(sortedJson({ ok: true, logo_url: url }));
  });

  app.delete("/api/v1/org/logo", async (req, reply) => {
    const user = await requireUser(identity, req);
    requireAdminRole(user);
    await identity.orgs.setLogoUrl(user.org_id, null);
    return reply.status(200).send({ ok: true });
  });

  // Serves the logo bytes publicly. A stale object after a re-upload with a
  // different extension 404s only until the new key is written — the URL is
  // stable, so <img> tags never need refreshing.
  app.get("/api/v1/orgs/:orgId/logo", async (req, reply) => {
    const orgId = parseUuidParam(req, "orgId");
    const org = await identity.orgs.get(orgId);
    if (org.logo_url === null) throw ApiError.notFound("no logo set");
    for (const [, ext] of LOGO_TYPES) {
      const key = `orgs/${orgId}/logo.${ext}`;
      let bytes: Buffer;
      try {
        bytes = await objects.get(key);
      } catch {
        continue;
      }
      const ct = LOGO_TYPES.find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
      return reply
        .status(200)
        .type(ct)
        .header("cache-control", "public, max-age=60")
        .send(bytes);
    }
    throw ApiError.notFound("no logo set");
  });
}

function requireAdminRole(user: { role: string }): void {
  if (user.role !== "admin") throw ApiError.forbidden();
}

function queryOne(req: FastifyRequest, name: string): string | undefined {
  const url = new URL(req.url, "http://local");
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}
