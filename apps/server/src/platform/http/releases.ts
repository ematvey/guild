// Client release downloads: admin
// upload → user download via short-lived signed URLs, plus the Tauri
// updater manifest. Artifacts are ed25519-signed over the sha256 digest so
// downloads are verifiable offline.

import { createHmac, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import type { ObjectStore } from "../s3.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireUser, requireAdminUser, queryParam, sendJson, bodyBytes } from "./error.js";
import { sha256Hex, safeFilename, validPlatform, type ReleaseRow } from "../store/releases.js";
import { SIGNING_SEED_KV } from "../store/org-kv.js";
import { uuidv7 } from "../time.js";

const MASTER_KEY_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function objectKey(version: string, kind: string, platform: string, id: string, filename: string): string {
  return `releases/${version}/${kind}/${platform}/${id}/${filename}`;
}

/** Short-lived signed download URL: `/dl?exp=<unix>&sig=<hmac(id,exp)>`. */
function signDownload(ctx: IdentityCtx, id: string, exp: number): string {
  const sig = createHmac("sha256", ctx.config.jwtSecret).update(`${id}:${exp}`).digest("hex");
  return `/api/v1/releases/${id}/download?exp=${exp}&sig=${sig}`;
}

function verifySignature(ctx: IdentityCtx, id: string, exp: number, sig: string): void {
  if (exp < Math.floor(Date.now() / 1000)) {
    throw ApiError.unauthorized("download link expired");
  }
  const expected = createHmac("sha256", ctx.config.jwtSecret).update(`${id}:${exp}`).digest("hex");
  // Constant-time: the signature gates authenticated downloads.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw ApiError.unauthorized("bad download signature");
  }
}

/** The release-signing ed25519 seed, in order: GUILD_RELEASE_SIGNING_SEED
 *  env (hex, 32 bytes), the auto-generated seed persisted in server_kv,
 *  generate-once. */
async function signingSeed(ctx: IdentityCtx): Promise<Buffer> {
  const envSeed = process.env.GUILD_RELEASE_SIGNING_SEED;
  if (envSeed !== undefined && envSeed.trim() !== "") {
    return decodeSeed(envSeed);
  }
  const existing = await ctx.kv.get(SIGNING_SEED_KV);
  if (existing !== null) return decodeSeed(existing);
  const hexSeed = randomBytes(32).toString("hex");
  await ctx.kv.put(SIGNING_SEED_KV, hexSeed);
  return decodeSeed(hexSeed);
}

function decodeSeed(seedHex: string): Buffer {
  const trimmed = seedHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw ApiError.internal("signing seed must be 32 bytes");
  }
  return Buffer.from(trimmed, "hex");
}

/** ed25519 private key from the 32-byte seed (PKCS#8 DER wrapping, the
 *  standard RFC 8410 encoding the Rust ed25519-dalek seed produces too). */
function ed25519PrivateKey(seed: Buffer): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.concat([MASTER_KEY_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** Signs the 32-byte sha256 digest of an artifact; returns the hex
 *  signature (ed25519 over the digest, same bytes ed25519-dalek emits). */
function signDigest(seed: Buffer, digest: Buffer): string {
  return cryptoSign(null, digest, ed25519PrivateKey(seed)).toString("hex");
}

async function verifyingKeyHex(ctx: IdentityCtx): Promise<string> {
  const seed = await signingSeed(ctx);
  const publicKey = createPublicKey(ed25519PrivateKey(seed));
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("hex");
}

/** Semver ordering (semver.org §11): major/minor/patch numerically; a
 *  prerelease ranks BELOW its release; prerelease identifiers compare
 *  numerically when numeric, ASCII lexically otherwise, numeric <
 *  alphanumeric, and a longer identifier set outranks a prefix; build
 *  metadata is ignored. `gt(a, b)` = a > b strictly. */
export function versionGt(a: string, b: string): boolean {
  const [coreA, preA] = splitPrerelease(a);
  const [coreB, preB] = splitPrerelease(b);
  const nums = (core: string): number[] => core.split(".").map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
  const na = nums(coreA);
  const nb = nums(coreB);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  if (preA === null && preB === null) return false;
  if (preA === null) return true; // a release outranks any prerelease
  if (preB === null) return false;
  const idsA = preA.split(".");
  const idsB = preB.split(".");
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const x = idsA[i];
    const y = idsB[i];
    if (x !== undefined && y !== undefined) {
      const nx = /^\d+$/.test(x) ? Number(x) : null;
      const ny = /^\d+$/.test(y) ? Number(y) : null;
      if (nx !== null && ny !== null) {
        if (nx > ny) return true;
        if (nx < ny) return false;
      } else if (nx !== null && ny === null) {
        return false; // numeric identifiers rank BELOW alphanumeric ones
      } else if (nx === null && ny !== null) {
        return true;
      } else if (x !== y) {
        return x > y;
      }
    } else if (x !== undefined) {
      return true; // longer set wins
    } else {
      return false;
    }
  }
  return false;
}

/** Splits `major.minor.patch[-prerelease][+build]`; build metadata is
 *  dropped, the prerelease (if any) is returned separately. */
function splitPrerelease(v: string): [string, string | null] {
  const noBuild = v.split("+")[0] ?? v;
  const dash = noBuild.indexOf("-");
  if (dash === -1) return [noBuild, null];
  return [noBuild.slice(0, dash), noBuild.slice(dash + 1)];
}

/** Whether `filename` is the updater bundle for `target` (plugin artifact
 *  kinds). */
function updaterArtifact(target: string, filename: string): boolean {
  switch (target) {
    case "linux-x86_64":
      return filename.endsWith(".AppImage");
    case "windows-x86_64":
      return filename.endsWith("-setup.exe");
    case "darwin-x86_64":
    case "darwin-aarch64":
      return filename.endsWith(".app.tar.gz");
    default:
      return false;
  }
}

export function registerReleaseRoutes(
  app: FastifyInstance,
  gateway: GatewayCtx,
  ctx: IdentityCtx,
  objects: ObjectStore,
): void {
  app.post("/api/v1/admin/releases", { bodyLimit: 512 * 1024 * 1024 }, async (req, reply) => {
    await requireAdminUser(ctx, req);
    const version = queryParam(req, "version");
    if (version === undefined) throw ApiError.badRequest("missing version");
    if (
      version === "" ||
      version.length > 64 ||
      ![...version].every((c) => /[a-zA-Z0-9.\-_]/.test(c))
    ) {
      throw ApiError.badRequest("bad version");
    }
    const kind = queryParam(req, "kind");
    if (kind === undefined) throw ApiError.badRequest("missing kind");
    if (kind !== "cli" && kind !== "desktop") {
      throw ApiError.badRequest("kind must be cli or desktop");
    }
    const platform = queryParam(req, "platform");
    if (platform === undefined) throw ApiError.badRequest("missing platform");
    if (!validPlatform(platform)) throw ApiError.badRequest("unknown platform");
    const rawFilename = queryParam(req, "filename");
    if (rawFilename === undefined) throw ApiError.badRequest("missing filename");
    const filename = safeFilename(rawFilename);
    if (filename === null) throw ApiError.badRequest("bad filename");
    const body = bodyBytes(req);
    if (body.length === 0) throw ApiError.badRequest("empty body");
    if (body.length > 512 * 1024 * 1024) {
      throw ApiError.badRequest("artifact too large (max 512MiB)");
    }
    const contentType = queryParam(req, "content_type") ?? "application/octet-stream";
    const notes = queryParam(req, "notes") ?? "";
    const updaterSignature = queryParam(req, "updater_sig") ?? "";

    const id = uuidv7();
    const key = objectKey(version, kind, platform, id, filename);
    try {
      await objects.put(key, body);
    } catch (error) {
      throw ApiError.internal(`object store write failed: ${(error as Error).message}`);
    }
    // ed25519-sign the artifact digest so downloads are verifiable offline
    const digest = sha256Hex(body);
    const seed = await signingSeed(ctx);
    const signature = signDigest(seed, Buffer.from(digest, "hex"));
    const created = await gateway.releases.create(
      id,
      version,
      kind,
      platform,
      filename,
      contentType,
      body.length,
      digest,
      signature,
      updaterSignature,
      notes,
      key,
    );
    sendJson(reply, created);
    return reply;
  });

  app.get("/api/v1/admin/releases", async (req, reply) => {
    await requireAdminUser(ctx, req);
    const rows = await gateway.releases.list();
    sendJson(reply, { releases: rows });
    return reply;
  });

  app.delete("/api/v1/admin/releases/:id", async (req, reply) => {
    await requireAdminUser(ctx, req);
    const id = parseUuidParam(req, "id");
    const deleted = await gateway.releases.delete(id);
    const key = objectKey(deleted.version, deleted.kind, deleted.platform, deleted.id, deleted.filename);
    try {
      await objects.delete(key);
    } catch {
      // best-effort
    }
    sendJson(reply, {});
    return reply;
  });

  app.get("/api/v1/releases", async (req, reply) => {
    await requireUser(ctx, req);
    const rows = await gateway.releases.list();
    sendJson(reply, { releases: rows });
    return reply;
  });

  app.get("/api/v1/releases/signing-key", async (req, reply) => {
    await requireUser(ctx, req);
    sendJson(reply, {
      public_key: await verifyingKeyHex(ctx),
      algorithm: "ed25519",
      signs: "sha256 digest of the artifact (hex)",
    });
    return reply;
  });

  app.get("/api/v1/releases/:id/download-url", async (req, reply) => {
    await requireUser(ctx, req);
    const id = parseUuidParam(req, "id");
    await gateway.releases.get(id);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    sendJson(reply, { url: signDownload(ctx, id, exp), expires_at: exp });
    return reply;
  });

  // Accepts either a valid signature (query) or a session bearer token.
  app.get("/api/v1/releases/:id/download", async (req, reply) => {
    const id = parseUuidParam(req, "id");
    const exp = queryParam(req, "exp");
    const sig = queryParam(req, "sig");
    let signed = false;
    if (exp !== undefined && sig !== undefined) {
      try {
        verifySignature(ctx, id, Number(exp), sig);
        signed = true;
      } catch {
        signed = false;
      }
    }
    if (!signed) {
      // fall back to session bearer auth (UIs that fetch with credentials)
      const header = req.headers.authorization;
      if (header === undefined || !header.startsWith("Bearer ")) {
        throw ApiError.unauthorized("expired link and no bearer token");
      }
      await ctx.identity.validateSession(header.slice("Bearer ".length));
    }
    const releaseRow: ReleaseRow = await gateway.releases.get(id);
    const key = objectKey(releaseRow.version, releaseRow.kind, releaseRow.platform, releaseRow.id, releaseRow.filename);
    let bytes: Buffer;
    try {
      bytes = await objects.get(key);
    } catch (error) {
      throw ApiError.internal(`object store read failed: ${(error as Error).message}`);
    }
    return reply
      .status(200)
      .type(releaseRow.content_type)
      .header("content-disposition", `attachment; filename="${releaseRow.filename}"`)
      .send(bytes);
  });

  // Tauri desktop auto-updater manifest. Public: static-JSON format from
  // the updater plugin, pointing at short-lived signed download URLs. Only
  // platforms with a signed updater artifact for the newest desktop version
  // are listed.
  app.get("/api/v1/updates/latest.json", async (_req, reply) => {
    const rows = await gateway.releases.list();
    let latest: { version: string; created_at: string } | null = null;
    for (const r of rows) {
      if (r.kind !== "desktop" || r.updater_signature === "") continue;
      if (latest === null || versionGt(r.version, latest.version)) {
        latest = { version: r.version, created_at: r.created_at };
      }
    }
    if (latest === null) return reply.status(204).send();
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    // the plugin needs absolute URLs: build them from the configured API
    // base URL — the request's Host header is attacker-controlled on the
    // direct-HTTP deployment, so it must not shape download origins
    const base = ctx.config.apiUrl.replace(/\/+$/, "");
    const platforms: Record<string, unknown> = {};
    for (const target of ["linux-x86_64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"]) {
      const row = rows.find(
        (r) =>
          r.kind === "desktop" &&
          r.version === latest!.version &&
          r.platform === target &&
          r.updater_signature !== "" &&
          updaterArtifact(target, r.filename),
      );
      if (row === undefined) continue;
      platforms[target] = {
        signature: row.updater_signature,
        url: `${base}${signDownload(ctx, row.id, exp)}`,
      };
    }
    if (Object.keys(platforms).length === 0) return reply.status(204).send();
    const notes = rows.find((r) => r.version === latest!.version && r.notes !== "")?.notes ?? "";
    // The manifest object keys are sorted like every json!-built body;
    // pub_date renders with chrono's to_rfc3339 (+00:00 offset).
    sendJson(reply, {
      version: latest.version,
      notes,
      pub_date: toRfc3339Offset(latest.created_at),
      platforms,
    });
    return reply;
  });
}

/** chrono's DateTime::to_rfc3339: UTC renders with a +00:00 offset, and the
 *  %.f fraction drops trailing zero groups (0 → absent). */
export function toRfc3339Offset(pgText: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?/.exec(pgText);
  if (m === null) throw new Error(`unexpected timestamp: ${pgText}`);
  let fraction = "";
  if (m[2] !== undefined) {
    const digits = m[2].replace(/0+$/, "");
    if (digits.length > 0) fraction = "." + digits.padEnd(digits.length <= 3 ? 3 : 6, "0");
  }
  return `${m[1]}${fraction}+00:00`;
}
