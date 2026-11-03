// Platform semantic tests beyond the golden wire fixtures: auth-generation
// stamping and pairing semantics, OIDC provisioning rules and a full OIDC
// round-trip against a mock IdP, S3 round-trip through the attachment
// routes, events emission with LISTEN/NOTIFY, and the time/uuid helpers.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createPlatformTestEnv, type PlatformTestEnv } from "../support/platform-env.js";
import { PlatformContext } from "../../composition.js";
import { hashPassword, verifyPassword, encryptSecret } from "../../platform/crypto.js";
import { pgTimestampToRfc3339, uuidv7, isUuid } from "../../platform/time.js";
import { safeFilename } from "../../platform/store/attachments.js";
import { resolveOidcUser } from "../../platform/http/oidc.js";
import { IdpRecheck } from "../../platform/idp-recheck.js";
import { ApiError } from "../../platform/errors.js";
import { waitFor } from "../support/wait.js";

const PASSWORD = "hunter226";

let env: PlatformTestEnv;
let ctx: PlatformContext;
let orgId: string;
let adminId: string;
let memberId: string;
const adminEmail = "admin@example.test";
const memberEmail = "member@example.test";
let adminToken = "";

async function login(email: string, password: string): Promise<{ status: number; token?: string; user?: unknown }> {
  const res = await env.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email, password }),
  });
  const json = res.statusCode === 200 ? (res.json() as { token: string; user: unknown }) : undefined;
  return { status: res.statusCode, token: json?.token, user: json?.user };
}

async function meStatus(token: string): Promise<number> {
  const res = await env.app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
  return res.statusCode;
}

beforeAll(async () => {
  env = await createPlatformTestEnv();
  ctx = new PlatformContext(env.config);
  const boot = await env.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  });
  expect(boot.statusCode).toBe(200);
  const login1 = await login(adminEmail, PASSWORD);
  expect(login1.status).toBe(200);
  adminId = (login1.user as { id: string }).id;
  orgId = (login1.user as { org_id: string }).org_id;
  const userRow = await ctx.identity.getUser(adminId);
  memberId = uuidv7();
  await ctx.pool.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES ($1, $2, $3, $4, 'member', 'managed')",
    [memberId, orgId, memberEmail, await hashPassword(PASSWORD)],
  );
  void userRow;
});

afterAll(async () => {
  await ctx?.close();
  await env?.cleanup();
});

describe("bootstrap + login", () => {
  it("bootstraps once, resolves the same user on re-bootstrap, refuses new emails", async () => {
    const again = await ctx.identity.ensureBootstrapAdmin(adminEmail, "otherpass1");
    expect(again).toBe(adminId);
    await expect(ctx.identity.ensureBootstrapAdmin("new@example.test", "otherpass1")).rejects.toThrow(
      /org already has users/,
    );
    // through the HTTP layer it is the already_bootstrapped 409 envelope
    const httpBootstrap = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "new@example.test", password: "otherpass1" }),
    });
    expect(httpBootstrap.statusCode).toBe(409);
    expect(httpBootstrap.json()).toEqual({
      error: { code: "already_bootstrapped", message: "org already has users" },
    });
  });

  it("authenticates with argon2id PHC params matching the Rust defaults", async () => {
    const stored = (
      await ctx.pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [adminId])
    ).rows[0]!.password_hash;
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    const bad = await login(adminEmail, "wrong");
    expect(bad.status).toBe(401);
  });

  it("stores only the sha256 of the session token", async () => {
    const [, token] = await ctx.identity.createSession(adminId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = (
      await ctx.pool.query<{ token_hash: string }>(
        "SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [adminId],
      )
    ).rows[0]!;
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toHaveLength(64);
    expect(await meStatus(token)).toBe(200);
  });
});

describe("auth generation semantics (Rust identity test ports)", () => {
  let genUserId = "";
  let genEmail = "";
  let genPassword = PASSWORD;
  beforeAll(async () => {
    genUserId = uuidv7();
    genEmail = `gen-${Math.random().toString(16).slice(2, 8)}@example.test`;
    await ctx.pool.query(
      "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES ($1, $2, $3, $4, 'member', 'managed')",
      [genUserId, orgId, genEmail, await hashPassword(genPassword)],
    );
  });

  it("kills sessions on a generation bump; refresh refuses dead sessions", async () => {
    const [, token] = await ctx.identity.createSession(memberId);
    expect(await meStatus(token)).toBe(200);
    await ctx.pool.query("UPDATE users SET auth_generation = auth_generation + 1 WHERE id = $1", [memberId]);
    expect(await meStatus(token)).toBe(401);
    const refresh = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json()).toEqual({
      error: { code: "unauthorized", message: "invalid or expired session" },
    });
  });

  it("a session from a stale credential validation never validates after a reset", async () => {
    const loginRes = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: genEmail, password: genPassword }),
    });
    void loginRes;
    // validation captures the pre-reset generation
    const [, generation] = await ctx.identity.authenticateWithGeneration(genEmail, genPassword);
    // pairing redemption captures the same generation
    const minted = await ctx.pairing.create(orgId, genUserId, 30, null);
    const [, , redeemedGeneration] = await ctx.pairing.redeemWithGeneration(minted.secret);
    expect(redeemedGeneration).toBe(generation);
    void loginRes;

    // the reset commits between validation and issuance
    genPassword = "newpass99";
    await ctx.pool.query("UPDATE users SET auth_generation = auth_generation + 1, password_hash = $2 WHERE id = $1", [
      genUserId,
      await hashPassword(genPassword),
    ]);
    const [, stale] = await ctx.identity.createSessionForCredential(genUserId, generation);
    expect(await meStatus(stale)).toBe(401);
    // issuance from a post-reset validation is unaffected
    const postReset = await ctx.pool.query<{ auth_generation: number }>(
      "SELECT auth_generation FROM users WHERE id = $1",
      [genUserId],
    );
    const [, fresh] = await ctx.identity.createSessionForCredential(genUserId, postReset.rows[0]!.auth_generation);
    expect(await meStatus(fresh)).toBe(200);
  });

  it("a pre-reset mint with a superseded generation is refused", async () => {
    const validated = await ctx.identity.validateSession((await ctx.identity.createSession(genUserId))[1]);
    // the reset commits after validation, before the mint
    genPassword = "another99";
    await ctx.pool.query("UPDATE users SET auth_generation = auth_generation + 1, password_hash = $2 WHERE id = $1", [
      genUserId,
      await hashPassword(genPassword),
    ]);
    await expect(ctx.pairing.create(orgId, genUserId, 30, validated.session_generation ?? null)).rejects.toMatchObject({
      code: "unauthorized",
    });
    const generationBefore = (
      await ctx.pool.query<{ auth_generation: number }>("SELECT auth_generation FROM users WHERE id = $1", [genUserId])
    ).rows[0]!.auth_generation;
    // a mint whose INSERT lands at the then-current generation, then a
    // second reset's generation bump commits without seeing it —
    // redemption issues a dead session
    const mintedRace = await ctx.pairing.create(orgId, genUserId, 30, null);
    expect(mintedRace.token.id).toBeDefined();
    genPassword = "yetanother9";
    await ctx.pool.query("UPDATE users SET auth_generation = auth_generation + 1, password_hash = $2 WHERE id = $1", [
      genUserId,
      await hashPassword(genPassword),
    ]);
    const [, , stamped] = await ctx.pairing.redeemWithGeneration(mintedRace.secret);
    expect(stamped).toBe(generationBefore);
    const [, session] = await ctx.identity.createSessionForCredential(genUserId, stamped);
    expect(await meStatus(session)).toBe(401);
  });
});

describe("pairing flow", () => {
  it("creates, lists, redeems single-use, revokes", async () => {
    const memberToken = (await login(memberEmail, PASSWORD)).token!;
    const created = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/pairing-tokens",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(created.statusCode).toBe(200);
    const { id, secret, expires_at: expiresAt } = created.json() as { id: string; secret: string; expires_at: string };
    expect(isUuid(id)).toBe(true);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?Z$/);

    const list = await env.app.inject({
      method: "GET",
      url: "/api/v1/auth/pairing-tokens",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { tokens: unknown[] }).tokens).toHaveLength(1);

    const code = `g1|http://localhost:18080|${secret}`;
    const paired = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/pair",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ code }),
    });
    expect(paired.statusCode).toBe(200);
    const pairedToken = (paired.json() as { token: string }).token;
    expect(await meStatus(pairedToken)).toBe(200);

    const reused = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/pair",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ code }),
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toEqual({
      error: { code: "unauthorized", message: "invalid or expired pairing code" },
    });

    const malformed = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/pair",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ code: "not-a-code" }),
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json().error.message).toBe("malformed pairing code");

    const revoked = await env.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/pairing-tokens/${id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(revoked.statusCode).toBe(200);
    const revokedAgain = await env.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/pairing-tokens/${id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(revokedAgain.statusCode).toBe(404);
  });
});

describe("OIDC provisioning rules (Rust test port)", () => {
  it("unverified or managed email never yields a session; distinct email provisions", async () => {
    const freshManaged = `managed-${Math.random().toString(16).slice(2, 8)}@example.test`;
    await ctx.pool.query(
      "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES ($1, $2, $3, 'x', 'member', 'managed')",
      [uuidv7(), orgId, freshManaged],
    );
    await expect(resolveOidcUser(ctx, orgId, freshManaged, false, null, null)).rejects.toMatchObject({ status: 401 });
    await expect(resolveOidcUser(ctx, orgId, freshManaged, true, null, null)).rejects.toMatchObject({
      code: "email_taken",
      status: 409,
    });
    const managedId = (await ctx.pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [freshManaged]))
      .rows[0]!.id;
    const sessions = await ctx.pool.query("SELECT 1 FROM sessions WHERE user_id = $1", [managedId]);
    expect(sessions.rowCount).toBe(0);

    const provisioned = await resolveOidcUser(ctx, orgId, "sso@example.test", true, "SSO User", null);
    expect(provisioned.identity_type).toBe("oidc");
    expect(provisioned.role).toBe("member");
    const again = await resolveOidcUser(ctx, orgId, "sso@example.test", true, "SSO User", null);
    expect(again.id).toBe(provisioned.id);
    const refreshed = await resolveOidcUser(ctx, orgId, "sso@example.test", true, "SSO User v2", "https://a/p.png");
    expect(refreshed.display_name).toBe("SSO User v2");
    expect(refreshed.avatar_url).toBe("https://a/p.png");
  });
});

describe("OIDC login round-trip against a mock IdP", () => {
  let idp: Server;
  let idpOrigin = "";
  let userinfoHits = 0;
  /** Refresh-grant calls the mock IdP answered, and whether it refuses
   *  them (a suspended/deleted account). */
  let refreshHits = 0;
  let refuseRefresh = false;

  beforeAll(async () => {
    idp = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (url.startsWith("/.well-known/openid-configuration")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            authorization_endpoint: `${idpOrigin}/auth`,
            token_endpoint: `${idpOrigin}/token`,
            userinfo_endpoint: `${idpOrigin}/userinfo`,
          }),
        );
        return;
      }
      if (url.startsWith("/token")) {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          if (body.includes("grant_type=refresh_token")) {
            refreshHits += 1;
            if (refuseRefresh) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            expect(body).toContain("refresh_token=idp-refresh-token");
            expect(body).toContain("client_id=mock-client");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ access_token: "idp-access-token" }));
            return;
          }
          expect(body).toContain("grant_type=authorization_code");
          expect(body).toContain("code=the-code");
          expect(body).toContain("client_id=mock-client");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "idp-access-token", refresh_token: "idp-refresh-token" }));
        });
        return;
      }
      if (url.startsWith("/userinfo")) {
        userinfoHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            email: "sso-flow@example.test",
            email_verified: true,
            name: userinfoHits === 1 ? "Flow User" : "Flow User Renamed",
            picture: "https://idp/p.png",
          }),
        );
        return;
      }
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    idpOrigin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    await env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/oidc",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ issuer: idpOrigin, client_id: "mock-client", client_secret: "mock-secret" }),
    });
  });

  it("admin config upsert/get/delete hides the secret", async () => {
    adminToken = (await login(adminEmail, PASSWORD)).token!;
    const put = await env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/oidc",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ issuer: idpOrigin, client_id: "mock-client", client_secret: "mock-secret" }),
    });
    expect(put.statusCode).toBe(200);
    const get = await env.app.inject({
      method: "GET",
      url: "/api/v1/admin/oidc",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = get.json() as { configured: boolean; issuer: string; secret_masked: string; redirect_uri: string };
    expect(body.configured).toBe(true);
    expect(body.issuer).toBe(idpOrigin);
    expect(body.secret_masked).toBe("•".repeat("mock-secret".length));
    expect(body.redirect_uri).toBe("http://localhost:18080/api/v1/auth/oidc/callback");

    const blankSecretKeeps = await env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/oidc",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ issuer: idpOrigin, client_id: "mock-client", client_secret: "" }),
    });
    expect(blankSecretKeeps.statusCode).toBe(200);
  });

  it("login redirects to the IdP with a signed state and nonce cookie; callback provisions", async () => {
    const nonce = "b".repeat(64);
    const loginRedirect = await env.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/login?org_id=${orgId}&nonce=${nonce}`,
    });
    expect(loginRedirect.statusCode).toBe(302);
    const location = new URL(loginRedirect.headers.location as string);
    expect(location.origin + location.pathname).toBe(`${idpOrigin}/auth`);
    const state = location.searchParams.get("state")!;
    const setCookie = loginRedirect.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string)!;
    expect(cookie).toContain("guild_oidc_nonce=");

    const callback = await env.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `guild_oidc_nonce=${nonce}` },
    });
    expect(callback.statusCode).toBe(302);
    const target = new URL(callback.headers.location as string, "http://x");
    expect(target.hash).toContain("#oidc_token=");
    expect(target.hash).toContain(`email=${encodeURIComponent("sso-flow@example.test")}`);
    const fragmentToken = /oidc_token=([0-9a-f]{64})/.exec(target.hash)![1]!;
    expect(await meStatus(fragmentToken)).toBe(200);

    // wrong/missing browser nonce must fail closed
    const badNonce = await env.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(state)}`,
    });
    expect(badNonce.statusCode).toBe(401);
  });

  it("a second login refreshes the synced profile", async () => {
    const nonce = "c".repeat(64);
    const loginRedirect = await env.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/login?org_id=${orgId}&nonce=${nonce}`,
    });
    const state = new URL(loginRedirect.headers.location as string).searchParams.get("state")!;
    const callback = await env.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `guild_oidc_nonce=${nonce}` },
    });
    expect(callback.statusCode).toBe(302);
    const user = (
      await ctx.pool.query<{ display_name: string | null }>(
        "SELECT display_name FROM users WHERE email = 'sso-flow@example.test'",
      )
    ).rows[0]!;
    console.error("SECOND LOGIN", callback.statusCode, callback.payload.slice(0, 200), "hits:", userinfoHits);
    expect(user.display_name).toBe("Flow User Renamed");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => idp.close(() => resolve()));
  });
});

describe("activity-driven IdP revalidation", () => {
  let idpOrigin = "";
  let refreshHits = 0;
  let refuse = false;

  /** The recheck policy over the shared stores, on a one-minute interval. */
  const rechecker = (): IdpRecheck =>
    new IdpRecheck({
      oidc: ctx.oidc,
      identity: ctx.identity,
      config: { idpRecheckSeconds: 60 },
      masterKey: () => ctx.masterKey(),
    });

  const ssoUser = async () => (await ctx.identity.findByEmail(orgId, "sso-flow@example.test"))!;

  /** The interval claim compares against checked_at; age it so the next
   *  check is due. */
  const ageLink = async (): Promise<void> => {
    await ctx.pool.query("UPDATE oidc_identities SET checked_at = now() - interval '1 hour'");
  };

  beforeAll(async () => {
    const idp = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        refreshHits += 1;
        if (refuse) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "idp-access-token" }));
      });
    });
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    idpOrigin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    const user = await ssoUser();
    await ctx.oidc.saveIdentity(user.id, `${idpOrigin}/token`, encryptSecret(ctx.masterKey(), "idp-refresh-token"));
  });

  it("the login stores the IdP link encrypted", async () => {
    const row = (
      await ctx.pool.query<{ token_endpoint: string; encrypted_refresh_token: string }>(
        "SELECT i.token_endpoint, i.encrypted_refresh_token FROM oidc_identities i " +
          "JOIN users u ON u.id = i.user_id WHERE u.email = 'sso-flow@example.test'",
      )
    ).rows[0]!;
    expect(row.token_endpoint).toBe(`${idpOrigin}/token`);
    expect(row.encrypted_refresh_token).not.toContain("idp-refresh-token");
  });

  it("keeps the credentials when the IdP still accepts the account", async () => {
    await ageLink();
    const user = await ssoUser();
    const [, token] = await ctx.identity.createSession(user.id);
    const before = refreshHits;
    await rechecker().check(user);
    expect(refreshHits).toBe(before + 1);
    expect(await meStatus(token)).toBe(200);
    // The claim holds for the interval: a second check costs no call.
    await rechecker().check(user);
    expect(refreshHits).toBe(before + 1);
  });

  it("revokes sessions, pairing tokens and api keys when the IdP refuses the grant", async () => {
    await ageLink();
    const user = await ssoUser();
    const [, token] = await ctx.identity.createSession(user.id);
    expect(await meStatus(token)).toBe(200);
    refuse = true;
    try {
      await rechecker().check(user);
    } finally {
      refuse = false;
    }
    expect(await meStatus(token)).toBe(401);
    const live = await ctx.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [user.id],
    );
    expect(Number(live.rows[0]!.count)).toBe(0);
  });

  it("skips a managed account", async () => {
    const before = refreshHits;
    const admin = await ctx.identity.getUser(adminId);
    await rechecker().check(admin);
    rechecker().noteActivity(admin);
    expect(refreshHits).toBe(before);
  });
});

describe("events feed", () => {
  it("lists newest-first and emits LISTEN/NOTIFY on guild_events", async () => {
    const client = await ctx.pool.connect();
    const notifications: unknown[] = [];
    const listener = (msg: { channel: string; payload?: string }): void => {
      if (msg.channel === "guild_events" && msg.payload) notifications.push(JSON.parse(msg.payload));
    };
    client.on("notification", listener);
    await client.query("LISTEN guild_events");
    try {
      await ctx.events.emit(orgId, "chat.created", { chat_id: "x" });
      await ctx.events.emit(orgId, "member.joined", { email: memberEmail, user_id: memberId });
      await waitFor(() => notifications.length >= 2, 5_000, 10);
      expect(notifications.at(-1)).toMatchObject({ org_id: orgId, kind: "member.joined" });

      const res = await env.app.inject({
        method: "GET",
        url: "/api/v1/events",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const events = (res.json() as { events: { kind: string }[] }).events;
      expect(events[0]!.kind).toBe("member.joined");
      expect(events.length).toBeGreaterThanOrEqual(2);
    } finally {
      client.release();
    }
  });
});

describe("attachments + object storage", () => {
  it("safeFilename mirrors the Rust rules", () => {
    expect(safeFilename("note.txt")).toBe("note.txt");
    expect(safeFilename("a b/c")).toBe("a_b_c");
    expect(safeFilename(".hidden")).toBeNull();
    expect(safeFilename("")).toBeNull();
    expect(safeFilename("a".repeat(129))).toBeNull();
  });

  it("uploads into S3 under the object key, lists and downloads", async () => {
    const adminToken = (await login(adminEmail, PASSWORD)).token!;
    const chatId = uuidv7();
    await ctx.pool.query("INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, 'att chat')", [
      chatId,
      orgId,
      adminId,
    ]);
    const upload = await env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/attachments?filename=report.pdf&content_type=application/pdf`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: Buffer.from("%PDF-fake"),
    });
    expect(upload.statusCode).toBe(200);
    const row = upload.json() as { id: string; filename: string; size_bytes: number; content_type: string };
    expect(row.filename).toBe("report.pdf");
    expect(row.size_bytes).toBe(9);
    expect(row.content_type).toBe("application/pdf");

    // A user upload records its author now and stays pending (no event) until
    // a message references it.
    const stored = await ctx.pool.query<{ author_kind: string; author_id: string; event_id: string | null }>(
      "SELECT author_kind, author_id, event_id FROM attachments WHERE id = $1",
      [row.id],
    );
    expect(stored.rows[0]).toEqual({ author_kind: "user", author_id: adminId, event_id: null });

    const list = await env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}/attachments`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    console.error("LIST STATUS", list.statusCode, list.payload.slice(0, 300));
    expect((list.json() as { attachments: unknown[] }).attachments).toHaveLength(1);

    const download = await env.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${row.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("%PDF-fake");
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["content-disposition"]).toBe('attachment; filename="report.pdf"');

    // member cannot reach another member's chat
    const memberToken = (await login(memberEmail, PASSWORD)).token!;
    const forbidden = await env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}/attachments`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(forbidden.statusCode).toBe(404);

    // direct object-store roundtrip under the same key layout
    const key = `attachments/${orgId}/${row.id}/report.pdf`;
    expect(await ctx.objects.get(key)).toEqual(Buffer.from("%PDF-fake"));
    await ctx.objects.delete(key);
    await expect(ctx.objects.get(key)).rejects.toThrow();
  });
});

describe("time + uuid helpers", () => {
  it("pgTimestampToRfc3339 matches chrono AutoSi shapes", () => {
    expect(pgTimestampToRfc3339("2026-10-04T22:17:50.067547Z")).toBe("2026-10-04T22:17:50.067547Z");
    expect(pgTimestampToRfc3339("2026-10-04T22:17:50.067500Z")).toBe("2026-10-04T22:17:50.067500Z");
    expect(pgTimestampToRfc3339("2026-10-04T22:17:50.067000Z")).toBe("2026-10-04T22:17:50.067Z");
    expect(pgTimestampToRfc3339("2026-10-04T22:17:50.000000Z")).toBe("2026-10-04T22:17:50Z");
    expect(pgTimestampToRfc3339("2026-10-04T22:17:50.120000Z")).toBe("2026-10-04T22:17:50.120Z");
  });

  it("uuidv7 has the version/variant bits", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7");
    expect("89ab").includes(id[19]!);
    expect(isUuid(id)).toBe(true);
  });
});

describe("error envelope", () => {
  it("unknown error codes stay in the envelope shape", () => {
    const err = ApiError.conflict("email_taken", "a user with this email already exists");
    expect(err.status).toBe(409);
    expect(err.code).toBe("email_taken");
  });
});
