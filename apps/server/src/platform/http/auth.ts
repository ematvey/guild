// Auth API — managed accounts: bootstrap, login, me, refresh, logout,
// pairing. Opaque random
// bearer tokens stored as sha256; sessions stamp the auth_generation of the
// credential that minted them.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityCtx } from "../route-contexts.js";
import type { PlatformPool } from "../db.js";
import { ApiError } from "../errors.js";
import { sortedJson } from "../domain/json.js";
import { requireJsonBody, requireStringFields, requireUser, parseUuidParam, sendJson } from "./error.js";
import { secretFromCode } from "../store/pairing.js";
import { addressThrottle, loginThrottle } from "./login-throttle.js";
import type { UserRow } from "../store/identity.js";
import type { UserInfo } from "@guild/wire/rest";

/** UserInfo in protocol::api field order (direct struct serialization). */
export function userInfo(u: UserRow): UserInfo {
  return {
    id: u.id,
    email: u.email,
    org_id: u.org_id,
    role: u.role,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    onboarded: u.onboarded_at != null,
  };
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (header === undefined) throw ApiError.unauthorized("missing authorization header");
  if (!header.startsWith("Bearer ")) throw ApiError.unauthorized("expected Bearer token");
  return header.slice("Bearer ".length);
}

function tooManyAttempts(retryAfterSec: number): ApiError {
  return new ApiError(
    429,
    "too_many_requests",
    `too many failed sign-in attempts; try again in ${retryAfterSec} seconds`,
  );
}

function attemptKeys(req: FastifyRequest, email: string): { emailKey: string; addressKey: string } {
  return {
    emailKey: `email:${email.trim().toLowerCase()}`,
    addressKey: `ip:${req.ip}`,
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: IdentityCtx, pool: PlatformPool): void {
  // The first org + admin user; the bootstrap credential is often the org's
  // only admin, so the same 8-char minimum as admin-created accounts applies.
  app.post("/api/v1/auth/bootstrap", async (req, reply) => {
    const body = requireJsonBody(req);
    const email = body["email"];
    const password = body["password"];
    if (typeof email !== "string") throw ApiError.badRequest("missing email");
    if (typeof password !== "string") throw ApiError.badRequest("missing password");
    if ([...password].length < 8) {
      throw ApiError.badRequest("password must be at least 8 characters");
    }
    const { emailKey, addressKey } = attemptKeys(req, email);
    if (loginThrottle.isLimited(emailKey) || addressThrottle.isLimited(addressKey)) {
      throw tooManyAttempts(Math.max(loginThrottle.retryAfterSeconds(emailKey), addressThrottle.retryAfterSeconds(addressKey)));
    }
    const anyUsers = await pool.query<{ count: number }>("SELECT COUNT(*) AS count FROM users");
    if (anyUsers.rows[0]!.count > 0) {
      throw ApiError.conflict("already_bootstrapped", "org already has users");
    }
    await ctx.identity.ensureBootstrapAdmin(email, password);
    loginThrottle.reset(emailKey);
    return reply.status(200).send({});
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const body = requireJsonBody(req);
    const fields = requireStringFields(body, ["email", "password"]);
    const { emailKey, addressKey } = attemptKeys(req, fields["email"]!);
    if (loginThrottle.isLimited(emailKey) || addressThrottle.isLimited(addressKey)) {
      throw tooManyAttempts(Math.max(loginThrottle.retryAfterSeconds(emailKey), addressThrottle.retryAfterSeconds(addressKey)));
    }
    let user: UserRow;
    let authGeneration: number;
    try {
      [user, authGeneration] = await ctx.identity.authenticateWithGeneration(
        fields["email"]!,
        fields["password"]!,
      );
    } catch (error) {
      loginThrottle.recordFailure(emailKey);
      addressThrottle.recordFailure(addressKey);
      throw error;
    }
    loginThrottle.reset(emailKey);
    // The session stamps the generation captured at validation: a password
    // reset that commits before issuance leaves it unable to validate.
    const [, token] = await ctx.identity.createSessionForCredential(user.id, authGeneration);
    return reply.status(200).send({ token, user: userInfo(user) });
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const user = await requireUser(ctx, req);
    void user;
    await ctx.identity.revokeSession(bearerToken(req));
    return reply.status(200).send({ ok: true });
  });

  app.post("/api/v1/auth/refresh", async (req, reply) => {
    const user = await requireUser(ctx, req);
    void user;
    const token = bearerToken(req);
    await ctx.identity.refreshSession(token);
    return reply.status(200).send({ token });
  });

  app.get("/api/v1/auth/me", async (req) => {
    const user = await requireUser(ctx, req);
    return userInfo(user);
  });

  // Redeems a one-time pairing code for a normal session. Unauthenticated:
  // the code IS the credential. Single-use and TTL-checked server-side.
  app.post("/api/v1/auth/pair", async (req, reply) => {
    const body = requireJsonBody(req);
    const fields = requireStringFields(body, ["code"]);
    const addressKey = `ip:${req.ip}`;
    if (addressThrottle.isLimited(addressKey)) {
      throw tooManyAttempts(addressThrottle.retryAfterSeconds(addressKey));
    }
    const secret = secretFromCode(fields["code"]!);
    if (secret === null) {
      addressThrottle.recordFailure(addressKey);
      throw ApiError.unauthorized("malformed pairing code");
    }
    let redeemed: [string, string, number];
    try {
      redeemed = await ctx.pairing.redeemWithGeneration(secret);
    } catch (error) {
      addressThrottle.recordFailure(addressKey);
      throw error;
    }
    const [orgId, userId, authGeneration] = redeemed;
    void orgId;
    const user = await ctx.identity.getUser(userId);
    // Same rule as password login: the session stamps the generation captured
    // at redemption, so a reset between the two cannot leave a live session.
    const [, token] = await ctx.identity.createSessionForCredential(user.id, authGeneration);
    return reply.status(200).send({ token, user: userInfo(user) });
  });

  // Issues a one-time pairing code for the calling user. The plaintext code
  // is returned once and composed client-side as
  // `g1.<b64url(server_url)>.<secret>` (the server URL is routing info).
  app.post("/api/v1/auth/pairing-tokens", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const body = requireJsonBody(req);
    let ttl = 30;
    if (body["ttl_minutes"] !== undefined) {
      const value = body["ttl_minutes"];
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw ApiError.badRequest("ttl_minutes must be an integer");
      }
      ttl = Math.min(Math.max(value, 1), 24 * 60);
    }
    const created = await ctx.pairing.create(user.org_id, user.id, ttl, user.session_generation ?? null);
    return reply.status(200).send({
      id: created.token.id,
      secret: created.secret,
      expires_at: created.token.expires_at,
    });
  });

  app.get("/api/v1/auth/pairing-tokens", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const rows = await ctx.pairing.listOutstanding(user.id);
    const tokens = rows.map((t) =>
      sortedJson({ id: t.id, created_at: t.created_at, expires_at: t.expires_at }),
    );
    return reply.status(200).send({ tokens });
  });

  app.delete("/api/v1/auth/pairing-tokens/:id", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const id = parseUuidParam(req, "id");
    await ctx.pairing.revoke(user.id, id);
    return reply.status(200).send({});
  });

  // The signed-in user's approval policy (migration 0026: user-scoped).
  // NULL = the server default (default Ask, read Allow).
  app.get("/api/v1/me/approval", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const approval = await ctx.identity.approval(user.id);
    return sendJson(reply, { approval });
  });

  // Saves (or with `{"approval": null}`, clears) the user's approval
  // policy. The stored JSON must deserialize as guild-core ApprovalPolicy —
  // invalid policies are rejected with 400 before touching the row.
  // Accepts the bare policy JSON, an `{"approval": …}` wrapper, or
  // `{"approval": null}`.
  app.put("/api/v1/me/approval", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const body = requireJsonBody(req);
    let value: unknown;
    if ("approval" in body) {
      if (body["approval"] === null) {
        value = null;
      } else {
        validateApprovalPolicy(body["approval"]);
        value = body["approval"];
      }
    } else {
      validateApprovalPolicy(body);
      value = body;
    }
    await ctx.identity.setApproval(user.id, value);
    return sendJson(reply, { approval: value });
  });

  // Marks the first-run onboarding wizard as done (finished or skipped).
  // Idempotent; the flag rides in login/me responses as `onboarded`.
  app.put("/api/v1/me/onboarded", async (req, reply) => {
    const user = await requireUser(ctx, req);
    await ctx.identity.markOnboarded(user.id);
    return reply.status(200).send({ ok: true });
  });
}

/** serde-shaped check of a guild-core ApprovalPolicy: `{ default?:
 *  "allow"|"ask"|"never", overrides?: Record<string, same> }` — unknown
 *  fields are ignored, as serde does without deny_unknown_fields. The
 *  rejection texts match the captured serde strings (fixtures/
 *  m7-rust-capture.json). */
function validateApprovalPolicy(value: unknown): void {
  const reject = (detail: string): ApiError =>
    ApiError.badRequest(`invalid approval policy: ${detail}`);
  const serdeKind = (v: unknown): string => {
    if (v === null) return "null";
    if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
    if (typeof v === "boolean") return `boolean \`${v}\``;
    if (typeof v === "string") return `string "${v}"`;
    if (Array.isArray(v)) return "sequence";
    return "map";
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw reject(`invalid type: ${serdeKind(value)}, expected struct ApprovalPolicy`);
  }
  const record = value as Record<string, unknown>;
  const approval = (v: unknown): void => {
    if (typeof v !== "string" || (v !== "allow" && v !== "ask" && v !== "never")) {
      throw reject(
        typeof v === "string"
          ? `unknown variant \`${v}\`, expected one of \`allow\`, \`ask\`, \`never\``
          : `invalid type: ${serdeKind(v)}, expected string or map`,
      );
    }
  };
  if (record["default"] !== undefined && record["default"] !== null) {
    approval(record["default"]);
  }
  const overrides = record["overrides"];
  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw reject(`invalid type: ${serdeKind(overrides)}, expected a map`);
    }
    for (const v of Object.values(overrides as Record<string, unknown>)) {
      approval(v);
    }
  }
}
