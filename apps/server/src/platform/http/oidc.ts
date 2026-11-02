// OIDC SSO configuration + login flow (spec §4.1): generic OIDC against
// the org's IdP, provisioning
// identity_type='oidc' users on first login.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IdentityCtx } from "../route-contexts.js";
import { decryptSecret, maskSecretLen } from "../crypto.js";
import { ApiError } from "../errors.js";
import { sortedJson } from "../domain/json.js";
import { requireJsonBody, requireAdminUser, queryParam } from "./error.js";
import { isUuid } from "../time.js";
import type { UserRow } from "../store/identity.js";

const STATE_TTL_SECONDS = 600;
const NONCE_COOKIE = "guild_oidc_nonce";

interface OidcStateClaims {
  org: string;
  /** Origin the login was started from; the callback redirects the browser
   *  back here with the session token in the URL fragment. */
  app: string;
  exp: number;
  nonce: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The OIDC state token: an HS256 JWT. */
function signStateJwt(ctx: IdentityCtx, claims: OidcStateClaims): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", ctx.config.jwtSecret).update(signingInput).digest();
  return `${signingInput}.${b64url(signature)}`;
}

function verifyStateJwt(ctx: IdentityCtx, token: string): OidcStateClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw ApiError.unauthorized("bad state");
  const [header, payload, signature] = parts as [string, string, string];
  let headerAlg: string;
  try {
    headerAlg = (JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string }).alg ?? "";
  } catch {
    throw ApiError.unauthorized("bad state");
  }
  if (headerAlg !== "HS256") throw ApiError.unauthorized("bad state");
  const expected = createHmac("sha256", ctx.config.jwtSecret).update(`${header}.${payload}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature, "base64url");
  } catch {
    throw ApiError.unauthorized("bad state");
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw ApiError.unauthorized("bad state");
  }
  let claims: OidcStateClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcStateClaims;
  } catch {
    throw ApiError.unauthorized("bad state");
  }
  // jsonwebtoken Validation::default(): exp is required, 60s leeway.
  if (typeof claims.exp !== "number" || Date.now() / 1000 > claims.exp + 60) {
    throw ApiError.unauthorized("bad state");
  }
  return claims;
}

/** The IdP redirect_uri and the post-login app redirect both come from the
 *  configured API base URL — raw Host/X-Forwarded-Proto headers are
 *  attacker-controlled on the direct-HTTP deployment and must not shape
 *  security-relevant URLs. */
function serverOrigin(ctx: IdentityCtx): string {
  return ctx.config.apiUrl.replace(/\/+$/, "");
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

async function fetchDiscovery(issuer: string): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw ApiError.internal(`oidc discovery failed: ${(error as Error).message}`);
  }
  if (!res.ok) throw ApiError.internal(`oidc discovery failed: ${res.status} ${res.statusText}`);
  try {
    const body = (await res.json()) as Partial<Discovery>;
    if (typeof body.authorization_endpoint !== "string" || typeof body.token_endpoint !== "string") {
      throw new Error("missing endpoints");
    }
    return {
      authorization_endpoint: body.authorization_endpoint,
      token_endpoint: body.token_endpoint,
      userinfo_endpoint: body.userinfo_endpoint,
    };
  } catch (error) {
    throw ApiError.internal(`oidc discovery parse failed: ${(error as Error).message}`);
  }
}

function validNonce(nonce: string): boolean {
  return nonce.length === 64 && /^[0-9a-fA-F]+$/.test(nonce);
}

function nonceCookie(ctx: IdentityCtx, nonce: string, maxAge: number): string {
  const secure = ctx.config.apiUrl.startsWith("https://") ? "; Secure" : "";
  return `${NONCE_COOKIE}=${nonce}; Path=/api/v1/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Constant-time, exactly-one-cookie nonce check (every Cookie header
 *  splits on ';'). */
function verifyBrowserNonce(cookieHeaders: string[], expected: string): void {
  const found: string[] = [];
  for (const header of cookieHeaders) {
    for (const cookie of header.split(/[;,]/)) {
      const trimmed = cookie.trim();
      if (trimmed.startsWith(`${NONCE_COOKIE}=`)) {
        found.push(trimmed.slice(NONCE_COOKIE.length + 1));
      }
    }
  }
  const ok =
    validNonce(expected) &&
    found.length === 1 &&
    found[0]!.length === expected.length &&
    timingSafeEqual(Buffer.from(found[0]!), Buffer.from(expected));
  if (!ok) {
    throw ApiError.unauthorized("login did not originate in this browser");
  }
}

/** RFC 3986 unreserved characters stay bare. */
function urlencode(s: string): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    if (
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2d ||
      b === 0x5f ||
      b === 0x2e ||
      b === 0x7e
    ) {
      out += String.fromCharCode(b);
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Resolves an OIDC login to a local user. The IdP-verified email is the
 *  only match key: unverified email claims are rejected, and a managed
 *  (password) account with the same address is never auto-matched — linking
 *  it to OIDC requires an explicit admin flow, otherwise anyone whose IdP
 *  asserts an arbitrary email could take over that account. */
export async function resolveOidcUser(
  ctx: IdentityCtx,
  org: string,
  email: string,
  emailVerified: boolean,
  displayName: string | null,
  avatarUrl: string | null,
): Promise<UserRow> {
  if (!emailVerified) {
    throw ApiError.unauthorized("idp did not verify the email claim");
  }
  const existing = await ctx.identity.findByEmail(org, email);
  if (existing !== null && existing.identity_type === "oidc") {
    if (existing.display_name !== displayName || existing.avatar_url !== avatarUrl) {
      await ctx.identity.updateOidcProfile(existing.id, displayName, avatarUrl);
      return { ...existing, display_name: displayName, avatar_url: avatarUrl };
    }
    return existing;
  }
  if (existing !== null) {
    throw ApiError.conflict(
      "email_taken",
      "this email belongs to a password account; oidc linking is a separate admin flow",
    );
  }
  return ctx.identity.createOidcUser(org, email, displayName, avatarUrl);
}

export function registerOidcRoutes(app: FastifyInstance, ctx: IdentityCtx): void {
  // ---------- admin config ----------

  app.put("/api/v1/admin/oidc", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    const body = requireJsonBody(req);
    const issuer = body["issuer"];
    const clientId = body["client_id"];
    if (typeof issuer !== "string") throw ApiError.badRequest("missing issuer");
    if (typeof clientId !== "string") throw ApiError.badRequest("missing client_id");
    // Blank secret = keep the stored one (the edit form's contract); an
    // empty string must not overwrite the encrypted secret.
    const clientSecret =
      typeof body["client_secret"] === "string" && body["client_secret"] !== "" ? body["client_secret"] : null;
    await ctx.oidc.upsert(admin.org_id, issuer, clientId, clientSecret, ctx.masterKey());
    return reply.status(200).send({});
  });

  app.get("/api/v1/admin/oidc", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    // The redirect URI the server actually uses (built from the configured
    // API URL): IdP registration must match this, so settings shows it
    // instead of a window.location.origin guess that diverges inside the
    // desktop webview.
    const redirectUri = `${serverOrigin(ctx)}/api/v1/auth/oidc/callback`;
    const row = await ctx.oidc.get(admin.org_id);
    if (row === null) {
      return reply.status(200).send({ configured: false, redirect_uri: redirectUri });
    }
    // Length-only bullet preview so the edit form's secret field can show a
    // mask of the real stored length (never any content).
    let secretMasked: string | null = null;
    try {
      const secret = decryptSecret(ctx.masterKey(), row.encrypted_client_secret);
      secretMasked = maskSecretLen([...secret].length);
    } catch {
      secretMasked = null;
    }
    return reply.status(200).send(
      sortedJson({
        configured: true,
        issuer: row.issuer,
        client_id: row.client_id,
        secret_masked: secretMasked,
        redirect_uri: redirectUri,
      }),
    );
  });

  app.delete("/api/v1/admin/oidc", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    await ctx.oidc.remove(admin.org_id);
    return reply.status(200).send({});
  });

  // ---------- login flow ----------

  // Public: tells the sign-in page whether SSO is available and where to
  // start it. Guild is effectively single-org, so the org is resolved here.
  app.get("/api/v1/auth/oidc/status", async (_req, reply) => {
    const org = await ctx.oidc.firstOrgId();
    if (org === null) return reply.status(200).send({ configured: false });
    const configured = (await ctx.oidc.get(org)) !== null;
    return reply.status(200).send({ configured, org_id: org });
  });

  // Starts the OIDC login: 302 to the IdP's authorization endpoint.
  app.get("/api/v1/auth/oidc/login", async (req, reply) => {
    const nonce = queryParam(req, "nonce");
    if (nonce === undefined || !validNonce(nonce)) {
      throw ApiError.badRequest("missing or invalid login nonce");
    }
    const orgId = queryParam(req, "org_id");
    if (orgId === undefined || !isUuid(orgId)) {
      throw ApiError.badRequest("missing org_id");
    }
    const row = await ctx.oidc.get(orgId);
    if (row === null) throw ApiError.notFound("no oidc config for org");
    const discovery = await fetchDiscovery(row.issuer);
    const appOrigin = serverOrigin(ctx);
    const redirectUri = `${appOrigin}/api/v1/auth/oidc/callback`;
    const state = signStateJwt(ctx, {
      org: orgId,
      app: appOrigin,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
      nonce,
    });
    const authUrl = new URL(discovery.authorization_endpoint);
    for (const [k, v] of [
      ["response_type", "code"],
      ["client_id", row.client_id],
      ["redirect_uri", redirectUri],
      ["scope", "openid email profile"],
      ["state", state],
    ]) {
      authUrl.searchParams.set(k, v);
    }
    return reply
      .status(302)
      .header("location", authUrl.toString())
      .header("set-cookie", nonceCookie(ctx, nonce, STATE_TTL_SECONDS))
      .send();
  });

  app.get("/api/v1/auth/oidc/callback", async (req, reply) => {
    const code = queryParam(req, "code");
    if (code === undefined) throw ApiError.badRequest("missing code");
    const stateParam = queryParam(req, "state");
    if (stateParam === undefined) throw ApiError.badRequest("missing state");
    const oidcState = verifyStateJwt(ctx, stateParam);
    const cookieHeaders = req.headers.cookie ? [req.headers.cookie] : [];
    verifyBrowserNonce(cookieHeaders, oidcState.nonce);
    const org = oidcState.org;

    const row = await ctx.oidc.get(org);
    if (row === null) throw ApiError.notFound("no oidc config for org");
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(ctx.masterKey(), row.encrypted_client_secret);
    } catch (error) {
      throw ApiError.internal(`secret decrypt failed: ${(error as Error).message}`);
    }
    const discovery = await fetchDiscovery(row.issuer);
    const redirectUri = `${oidcState.app.replace(/\/+$/, "")}/api/v1/auth/oidc/callback`;

    let tokenResp: { access_token?: string };
    try {
      const res = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: row.client_id,
          client_secret: clientSecret,
        }).toString(),
      });
      if (!res.ok) {
        throw ApiError.unauthorized(`oidc token exchange failed: ${res.status} ${res.statusText}`);
      }
      tokenResp = (await res.json()) as { access_token?: string };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.internal(`oidc token exchange failed: ${(error as Error).message}`);
    }
    if (typeof tokenResp.access_token !== "string") {
      throw ApiError.internal("oidc token parse failed: missing access_token");
    }

    const userinfoEndpoint = discovery.userinfo_endpoint;
    if (userinfoEndpoint === undefined) {
      throw ApiError.internal("idp has no userinfo endpoint");
    }
    let userinfo: Record<string, unknown>;
    try {
      const res = await fetch(userinfoEndpoint, {
        headers: { authorization: `Bearer ${tokenResp.access_token}` },
      });
      if (!res.ok) {
        throw ApiError.unauthorized(`oidc userinfo failed: ${res.status} ${res.statusText}`);
      }
      userinfo = (await res.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.internal(`oidc userinfo parse failed: ${(error as Error).message}`);
    }

    const email = userinfo["email"];
    if (typeof email !== "string") {
      throw ApiError.unauthorized("idp returned no email claim");
    }
    const emailVerified = userinfo["email_verified"] === true;
    const displayName = typeof userinfo["name"] === "string" ? userinfo["name"] : null;
    const avatarUrl = typeof userinfo["picture"] === "string" ? userinfo["picture"] : null;

    // Provision on first login with the IdP profile, refresh it when the
    // claims change, then hand out a session.
    const user = await resolveOidcUser(ctx, org, email, emailVerified, displayName, avatarUrl);
    const [, token] = await ctx.identity.createSession(user.id);

    // Back to the web app; the token rides in the URL fragment so it never
    // reaches the server again, and the app picks it up on load.
    const target = `${oidcState.app.replace(/\/+$/, "")}/#oidc_token=${urlencode(token)}&email=${urlencode(email)}&nonce=${oidcState.nonce}`;
    return reply
      .status(302)
      .header("location", target)
      .header("set-cookie", nonceCookie(ctx, "", 0))
      .send();
  });
}
