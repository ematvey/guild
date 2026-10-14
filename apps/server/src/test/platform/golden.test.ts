// Golden wire-contract tests: replays the captured Rust request/response
// pairs (apps/server/src/test/golden/fixtures.json — captured from the live
// Rust server, token material redacted) against the native TS routes and
// asserts byte-semantic equality: exact status, exact body text modulo
// dynamic values (uuids masked, timestamps masked to the chrono AutoSi
// shape, harvested tokens/ids substituted), exact noted headers.
//
// Sequence state lives in the substitution map: sessions minted by replayed
// logins feed later bearers, uploaded attachment/pairing ids feed later
// paths, exactly as in the capture run.

import { readFileSync } from "node:fs";
import pg from "pg";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createM1TestEnv, type M1TestEnv } from "./harness.js";
import { hashPassword } from "../../platform/crypto.js";
import { uuidv7 } from "../../platform/time.js";

const fixturesPath = path.join(import.meta.dirname, "../golden/fixtures.json");
const { fixtures } = JSON.parse(readFileSync(fixturesPath, "utf8")) as {
  fixtures: CapturedFixture[];
};

interface CapturedFixture {
  name: string;
  request: { method: string; path: string; headers: Record<string, string>; body?: string };
  response: { status: number; headers: Record<string, string>; body: string | { base64: string; length: number } };
}

// Text-rejection fixtures whose tails are parser-specific (serde's detail
// vs V8's): compare status + the shared axum prefix.
const PREFIX_MATCH = new Set(["login-invalid-json", "bootstrap-invalid-json"]);

let env: M1TestEnv;
let db: pg.Pool;

beforeAll(async () => {
  env = await createM1TestEnv();
  db = env.db;
});

afterAll(async () => {
  await env?.cleanup();
});

// ---------- substitution state ----------
type Pair = [captured: string, actual: string];
const requestPairs: Pair[] = []; // captured → actual, applied to requests
const responsePairs: Pair[] = []; // actual → captured, applied to replay responses

function substitute(text: string, pairs: Pair[]): string {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// chrono serde AutoSi shape: 0, 3, 6 or 9 fractional digits.
const RFC3339_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6}|\.\d{9})?(Z|[+-]\d{2}:\d{2})/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// serde's column position tracks the (substituted) body length, so mask it.
const COLUMN_RE = / at line 1 column \d+/g;

const URL_RE = /https?:\/\/[^\s"]+/g;

function mask(text: string): string {
  return text
    .replace(URL_RE, "«url»")
    .replace(COLUMN_RE, " «col»")
    .replace(EMAIL_RE, "«email»")
    .replace(RFC3339_RE, "«ts»")
    .replace(UUID_RE, "«uuid»");
}

function normalizeContentType(value: string): string {
  return value.replace("; charset=utf-8", "");
}

const PASSWORD = "m1capture-Pw1!";
const ADMIN_EMAIL_SEEDED = `golden-admin-${Math.random().toString(16).slice(2, 8)}@example.test`;
const MEMBER_EMAIL_SEEDED = `golden-member-${Math.random().toString(16).slice(2, 8)}@example.test`;

let seeded = false;
const ids = { org: "", admin: "", member: "", chat: "" };

async function seed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  ids.org = uuidv7();
  ids.admin = uuidv7();
  ids.member = uuidv7();
  ids.chat = uuidv7();
  const hash = await hashPassword(PASSWORD);
  await db.query("INSERT INTO orgs (id, name) VALUES ($1, 'm1-capture org')", [ids.org]);
  await db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES " +
      "($1, $2, $3, $4, 'admin', 'managed'), ($5, $2, $6, $4, 'member', 'managed')",
    [ids.admin, ids.org, ADMIN_EMAIL_SEEDED, hash, ids.member, MEMBER_EMAIL_SEEDED],
  );
  await db.query("INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, 'm1 capture chat')", [
    ids.chat,
    ids.org,
    ids.admin,
  ]);
  await db.query(
    "INSERT INTO events (id, org_id, kind, payload) VALUES ($1, $2, 'member.joined', " +
      "jsonb_build_object('email', $3::text, 'user_id', $4::text))",
    [uuidv7(), ids.org, ADMIN_EMAIL_SEEDED, ids.admin],
  );

  // The fixture's captured ids/emails, derived from the fixtures themselves.
  const orgIdCaptured = (fixtureBody("events-list").events as Record<string, unknown>[])[0]!["org_id"] as string;
  const adminIdCaptured = fixtureBody("me-ok").id as string;
  const chatIdCaptured = fixtureBody("attachment-upload-ok").chat_id as string;
  const adminEmailCaptured = fixtureRequest("login-ok").body.email as string;
  const memberEmailCaptured = fixtureRequest("login-member").body.email as string;
  requestPairs.push(
    [orgIdCaptured, ids.org],
    [chatIdCaptured, ids.chat],
    [adminEmailCaptured, ADMIN_EMAIL_SEEDED],
    [memberEmailCaptured, MEMBER_EMAIL_SEEDED],
  );
  void adminIdCaptured;
  // oidc-login-bad-org expects a config-LESS org; at replay the seeded org
  // has one (status fixture prepare), so retarget this request at an org
  // that does not exist.
  REQUEST_OVERRIDES["oidc-login-bad-org"] = [[ids.org, "22222222-2222-4222-8222-222222222222"]];
}

type FixtureBody = Record<string, unknown>;
function fixtureBody(name: string): FixtureBody {
  const f = fixtures.find((x) => x.name === name)!;
  return JSON.parse(f.response.body as string) as FixtureBody;
}
function fixtureRequest(name: string): { body: FixtureBody; path: string } {
  const f = fixtures.find((x) => x.name === name)!;
  return { body: JSON.parse(f.request.body ?? "{}") as FixtureBody, path: f.request.path };
}

/** Per-fixture state preparation mirroring the capture-run precondition. */
const PREPARE: Record<string, (ctx: { orgId: string }) => Promise<void>> = {
  "org-get": async ({ orgId }) => {
    await db.query("UPDATE orgs SET name = 'm1-capture org' WHERE id = $1", [orgId]);
  },
  "oidc-admin-config-get": async ({ orgId }) => {
    // The capture org had no OIDC config at this point (the config the
    // status fixture saw belongs to another org).
    await db.query("DELETE FROM oidc_configs WHERE org_id = $1", [orgId]);
  },
  "oidc-status": async ({ orgId }) => {
    // The capture org had an OIDC config at status time; provision the same
    // on the replay org (the admin PUT/GET fixtures ran before this point
    // in the capture sequence).
    const existing = await db.query("SELECT 1 FROM oidc_configs WHERE org_id = $1", [orgId]);
    if (existing.rows.length === 0) {
      await db.query(
        "INSERT INTO oidc_configs (id, org_id, issuer, client_id, encrypted_client_secret) VALUES ($1, $2, $3, $4, $5)",
        [uuidv7(), orgId, "https://idp.example.test", "cid", "ab".repeat(32)],
      );
    }
  },
};

/** Post-substitution request overrides per fixture. */
const REQUEST_OVERRIDES: Record<string, Pair[]> = {};

describe("golden fixtures: auth + org + events + attachments + oidc wire contracts", () => {
  it(
    "replays every captured request/response pair byte-semantically",
    { timeout: 120_000 },
    async () => {
      let failures: string[] = [];
      for (const fixture of fixtures) {
        const problem = await replayFixture(fixture);
        if (problem !== null) failures.push(problem);
      }
      failures = failures.filter(Boolean);
      if (failures.length > 0) {
        throw new Error(`golden mismatches:\n${failures.join("\n")}`);
      }
      expect(failures).toEqual([]);
    },
  );
});

async function replayFixture(fixture: CapturedFixture): Promise<string | null> {
  await seed();
  const prepare = PREPARE[fixture.name];
  if (prepare) await prepare({ orgId: ids.org });

  let path = substitute(fixture.request.path, requestPairs);
  for (const [from, to] of REQUEST_OVERRIDES[fixture.name] ?? []) {
    path = path.split(from).join(to);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(fixture.request.headers)) {
    headers[key] = substitute(value, requestPairs);
  }
  const rawBody = fixture.request.body;
  const payload =
    typeof rawBody === "string" ? substitute(rawBody, requestPairs) : undefined;

  const res = await env.app.inject({
    method: fixture.request.method as "GET",
    url: path,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });

  const expectedStatus = fixture.response.status;
  if (res.statusCode !== expectedStatus) {
    return `- ${fixture.name}: status ${res.statusCode} != ${expectedStatus}; body ${res.body.slice(0, 300)}`;
  }

  // Harvest state (tokens, ids) BEFORE comparing: self-referential fixtures
  // (login minting the session later requests bear) need the inverse
  // substitution in place for their own response comparison.
  harvest(fixture, res.body);

  const fixtureBody = fixture.response.body;
  if (typeof fixtureBody === "object") {
    // binary fixture: exact bytes
    const raw = res.rawPayload ?? Buffer.from(res.body, "binary");
    if (raw.toString("base64") !== fixtureBody.base64 || raw.length !== fixtureBody.length) {
      return `- ${fixture.name}: binary body mismatch (${raw.length} bytes)`;
    }
    return headerProblem(fixture, res);
  }
  const fixtureBodyText = fixtureBody;
  const actualBodyText = substitute(res.body, responsePairs);
  const expectedMasked = mask(fixtureBodyText);
  const actualMasked = mask(actualBodyText);
  if (PREFIX_MATCH.has(fixture.name)) {
    const prefix = "Failed to parse the request body as JSON: ";
    if (!actualMasked.startsWith(prefix)) {
      return `- ${fixture.name}: body ${actualMasked.slice(0, 200)} does not start with "${prefix}"`;
    }
  } else if (actualMasked !== expectedMasked) {
    return `- ${fixture.name}: body mismatch\n  expected: ${expectedMasked.slice(0, 400)}\n  actual:   ${actualMasked.slice(0, 400)}`;
  }

  return headerProblem(fixture, res);
}

function headerProblem(fixture: CapturedFixture, res: { headers: Record<string, unknown> }): string | null {
  for (const [header, expected] of Object.entries(fixture.response.headers)) {
    const actual = res.headers[header];
    let actualText = Array.isArray(actual) ? actual.join(", ") : String(actual ?? "");
    if (header === "content-type") actualText = normalizeContentType(actualText);
    if (actualText !== expected) {
      return `- ${fixture.name}: header ${header} "${actualText}" != "${expected}"`;
    }
  }
  return null;
}

/** Registers captured→actual pairs from a replayed fixture's response. */
function harvest(fixture: CapturedFixture, actualBody: string): void {
  let actualJson: Record<string, unknown> | null = null;
  try {
    actualJson = JSON.parse(actualBody) as Record<string, unknown>;
  } catch {
    return;
  }
  const capturedJson = (() => {
    try {
      return JSON.parse(fixture.response.body as string) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

  const push = (captured: unknown, actual: unknown): void => {
    if (typeof captured === "string" && typeof actual === "string" && captured !== actual) {
      requestPairs.push([captured, actual]);
      responsePairs.push([actual, captured]);
    }
  };

  switch (fixture.name) {
    case "login-ok":
    case "relogin":
    case "pair-ok":
    case "login-member": {
      if (actualJson?.token === undefined) break;
      const actual = actualJson.token as string;
      // request-side marker (bearer headers) and response-side marker
      // (the redacted token field in the fixture body)
      const markers: Record<string, [string, string]> = {
        "login-ok": ["REDACTED-ADMIN1", "SYNTH-ADMIN-TOKEN-1"],
        relogin: ["REDACTED-ADMIN2", "SYNTH-ADMIN-TOKEN-2"],
        "pair-ok": ["REDACTED-PAIR", "SYNTH-PAIR-TOKEN"],
        "login-member": ["REDACTED-MEMBER1", "SYNTH-MEMBER-TOKEN-1"],
      };
      const [requestMarker, bodyMarker] = markers[fixture.name]!;
      requestPairs.push([requestMarker, actual]);
      responsePairs.push([actual, bodyMarker]);
      break;
    }
    case "pairing-token-create":
    case "pairing-token-create-clamped":
    case "attachment-upload-ok":
      if (capturedJson !== null && actualJson !== null) {
        push(capturedJson["id"], actualJson["id"]);
        if (fixture.name === "pairing-token-create") {
          push("SYNTH-PT-SECRET-1", actualJson["secret"]);
        }
        if (fixture.name === "pairing-token-create-clamped") {
          push("SYNTH-PT-SECRET-2", actualJson["secret"]);
        }
      }
      break;
  }
}
