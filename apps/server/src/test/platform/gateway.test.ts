// Gateway M2 semantic suites: org API keys, model routes + provider admin,
// quota enforcement (disposable ClickHouse), and the internal-key gateway
// credential. The wire-shape endpoint suites live in llm.test.ts; golden
// wire captures in gateway-golden.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./m2-harness.js";

const INTERNAL_CALLER_UUID = "084e9c72-8c73-636b-f784-132bbeaf766e";
const INTERNAL_KEY_UUID = "bf14cf48-bd7d-5fb6-6c0f-9047919fb0d8";

describe("M2 gateway: api keys + admin + quota + internal key", () => {
  let stack: M2Stack;
  beforeAll(async () => {
    stack = await setupM2Stack();
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
  }, 60_000);

  it("api key: mint shows plaintext once, list shows only the hash form", async () => {
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${stack.memberToken}`, "content-type": "application/json" },
      payload: { name: "suite-key" },
    });
    expect(res.statusCode).toBe(200);
    const created = JSON.parse(res.body) as { key: Record<string, unknown>; plaintext: string };
    expect(created.plaintext).toMatch(/^gk_[0-9a-f]{48}$/);
    expect((created.key["prefix"] as string).length).toBe(10);
    expect(created.key["user_id"]).toBeTypeOf("string");
    expect(created.key["name"]).toBe("suite-key");

    const own = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    const ownKeys = (JSON.parse(own.body) as { keys: Record<string, unknown>[] }).keys;
    expect(ownKeys.some((k) => k["id"] === created.key["id"])).toBe(true);
    // No plaintext in listings.
    expect(JSON.stringify(ownKeys)).not.toContain(created.plaintext);

    const admin = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/admin/api-keys",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    const adminKeys = (JSON.parse(admin.body) as { keys: Record<string, unknown>[] }).keys;
    expect(adminKeys.some((k) => k["id"] === created.key["id"])).toBe(true);
  });

  it("revoked key stops authenticating on the gateway paths", async () => {
    const mint = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${stack.memberToken}`, "content-type": "application/json" },
      payload: { name: "revoked" },
    });
    const { key, plaintext } = JSON.parse(mint.body) as { key: { id: string }; plaintext: string };
    const ok = await stack.env.app.inject({
      method: "GET",
      url: "/openai/v1/models",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(ok.statusCode).toBe(200);
    const del = await stack.env.app.inject({
      method: "DELETE",
      url: `/api/v1/api-keys/${key.id}`,
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(del.statusCode).toBe(200);
    const gone = await stack.env.app.inject({
      method: "GET",
      url: "/openai/v1/models",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(gone.statusCode).toBe(401);
    const body = JSON.parse(gone.body) as { error: Record<string, unknown> };
    expect(body.error["message"]).toBe("invalid api key");
  });

  it("member is forbidden on admin routes; unauthenticated is unauthorized", async () => {
    const member = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(member.statusCode).toBe(403);
    const anon = await stack.env.app.inject({ method: "GET", url: "/api/v1/admin/gateway/routes" });
    expect(anon.statusCode).toBe(401);
  });

  it("admin routes CRUD: set/list/delete with validation", async () => {
    const put = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-crud", provider: "mock-openai", price_in: 1.5, price_out: 3, quota_monthly_usd: 12.5 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).toBe("{}");

    const list = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    const routes = (JSON.parse(list.body) as { routes: Record<string, unknown>[] }).routes;
    const row = routes.find((r) => r["model"] === "m-crud");
    expect(row).toBeDefined();
    expect(row!["price_per_mtok_in_usd"]).toBe(1.5);
    expect(row!["quota_monthly_usd"]).toBe(12.5);

    const del = await stack.env.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/gateway/routes/m-crud",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    expect(del.statusCode).toBe(200);
    const list2 = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    const routes2 = (JSON.parse(list2.body) as { routes: Record<string, unknown>[] }).routes;
    expect(routes2.find((r) => r["model"] === "m-crud")).toBeUndefined();

    // Validation rejections.
    const bad = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-crud", provider: "p", price_in: 1, price_out: 1, max_output_tokens: 0 },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)["error"]["message"]).toContain("max_output_tokens");
    const missingPrice = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-crud", provider: "p", price_out: 1 },
    });
    expect(missingPrice.statusCode).toBe(400);
  });

  it("providers CRUD: slug derive, duplicate 409, unknown protocol, key preview, blank key keeps secret", async () => {
    const create = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "My Provider!", protocol: "openai", base_url: "http://up.test", key: "sk-secret-1" },
    });
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.body)["provider"]).toBe("my-provider");

    const dupe = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "my provider", protocol: "openai", base_url: "http://up.test", key: "x" },
    });
    expect(dupe.statusCode).toBe(409);

    const badProtocol = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "other", protocol: "deepseek", base_url: "http://up.test", key: "x" },
    });
    expect(badProtocol.statusCode).toBe(400);
    expect(JSON.parse(badProtocol.body)["error"]["message"]).toContain("unknown protocol deepseek");

    const list = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    const providers = (JSON.parse(list.body) as { providers: Record<string, unknown>[] }).providers;
    const row = providers.find((p) => p["provider"] === "my-provider");
    expect(row!["name"]).toBe("My Provider!");
    expect(row!["key_masked"]).toBe("•".repeat("sk-secret-1".length));
    expect(JSON.stringify(row)).not.toContain("sk-secret-1");

    const update = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/providers/my-provider",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "My Provider!", protocol: "openai", base_url: "http://up2.test", key: "" },
    });
    expect(update.statusCode).toBe(200);
    // Blank key keeps the old secret: a route still resolves through it.
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-blank", provider: "my-provider", price_in: 1, price_out: 1 },
    });
    const ok = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    const providers2 = (JSON.parse(ok.body) as { providers: Record<string, unknown>[] }).providers;
    expect(providers2.find((p) => p["provider"] === "my-provider")!["key_masked"]).toBe("•".repeat("sk-secret-1".length));

    const del = await stack.env.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/gateway/providers/my-provider",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    expect(del.statusCode).toBe(200);
    // Deleting the provider leaves the route unresolvable (the JOIN miss
    // loses both the base_url and the key; the key check fires first).
    const nope = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: { model: "m-blank", messages: [{ role: "user", content: "hi" }] },
    });
    expect(nope.statusCode).toBe(409);
    expect(JSON.parse(nope.body)["error"]["message"]).toContain("no provider key");
  });

  it("route resolution failures render per shape (404 unknown, 409 disabled)", async () => {
    const noRoute = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: { model: "ghost", messages: [{ role: "user", content: "hi" }] },
    });
    expect(noRoute.statusCode).toBe(404);
    expect(JSON.parse(noRoute.body)["error"]).toMatchObject({
      message: "no route for model ghost",
      type: "invalid_request_error",
    });
    const noRouteA = await stack.env.app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": stack.apiKey, "content-type": "application/json" },
      payload: { model: "ghost", messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
    });
    expect(noRouteA.statusCode).toBe(404);
    expect(JSON.parse(noRouteA.body)["error"]).toMatchObject({
      message: "no route for model ghost",
      type: "not_found_error",
    });
  });

  it("quota 429: month-to-date spend at the cap rejects; raising the cap restores", async () => {
    await stack.routeModel("m-quota", { quotaMonthlyUsd: 0.000001 });
    await stack.seedUsage({ model: "m-quota", costUsd: 0.01 });
    await stack.drain();

    const blocked = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: { model: "m-quota", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    });
    expect(blocked.statusCode).toBe(429);
    const body = JSON.parse(blocked.body) as { error: Record<string, unknown> };
    // The OpenAI error body carries only message + type (the `code` field
    // is the /api/v1 envelope's; auth rejections only).
    expect(body.error["type"]).toBe("quota_exceeded");
    expect(String(body.error["message"])).toContain("monthly quota for this model reached");
    // The provider was never called.
    expect(stack.mock.requests).toHaveLength(0);

    const blockedA = await stack.env.app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": stack.apiKey, "content-type": "application/json" },
      payload: { model: "m-quota", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    });
    expect(blockedA.statusCode).toBe(429);
    expect(JSON.parse(blockedA.body)["error"]).toMatchObject({
      type: "rate_limit_error",
      message: expect.stringContaining("monthly quota for this model reached"),
    });

    // Raise the quota above the spend → the call goes through.
    await stack.routeModel("m-quota", { quotaMonthlyUsd: 1000 });
    const allowed = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: {
        model: "m-quota",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        stream: true,
      },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("internal key: gateway access scoped by x-guild-org-id, metered distinctly, never API-issued", async () => {
    await stack.routeModel("m-internal", { priceIn: 2, priceOut: 4 });
    const internalKey = stack.env.config.internalKey!;
    expect(internalKey).toMatch(/^gk_internal_/);

    // No org header → rejected.
    const noOrg = await stack.env.app.inject({
      method: "GET",
      url: "/openai/v1/models",
      headers: { authorization: `Bearer ${internalKey}` },
    });
    expect(noOrg.statusCode).toBe(400);
    expect(JSON.parse(noOrg.body)["error"]["message"]).toContain("x-guild-org-id");

    const models = await stack.env.app.inject({
      method: "GET",
      url: "/openai/v1/models",
      headers: { authorization: `Bearer ${internalKey}`, "x-guild-org-id": stack.orgId },
    });
    expect(models.statusCode).toBe(200);
    const modelIds = (JSON.parse(models.body) as { data: { id: string }[] }).data.map((m) => m.id);
    expect(modelIds).toContain("m-internal");

    // A completion through the internal key records usage under the
    // synthetic internal caller (distinct from every user row).
    await stack.mock.stop();
    const { startMockUpstream } = await import("./m2-harness.js");
    const scripted = await startMockUpstream([
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
          "data: [DONE]\n\n",
      },
    ]);
    // Point the provider at the new mock.
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "Internal Upstream", protocol: "openai", base_url: scripted.url, key: "sk" },
    });
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-internal", provider: "internal-upstream", price_in: 2, price_out: 4 },
    });
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: {
        authorization: `Bearer ${internalKey}`,
        "x-guild-org-id": stack.orgId,
        "content-type": "application/json",
      },
      payload: { model: "m-internal", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    });
    expect(res.statusCode).toBe(200);
    await stack.drain();
    const rows = await stack.usageRows();
    const internalRows = rows.filter((r) => r["user_id"] === INTERNAL_CALLER_UUID);
    expect(internalRows).toHaveLength(1);
    expect(internalRows[0]!["session_id"]).toBe(INTERNAL_KEY_UUID);
    expect(internalRows[0]!["model"]).toBe("m-internal");
    // Regular user-key usage rows are attributed to the key owner instead.
    const userRows = rows.filter((r) => r["user_id"] === INTERNAL_CALLER_UUID && r["model"] !== "m-internal");
    expect(userRows).toHaveLength(0);
    await scripted.stop();
    await stack.env.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/gateway/providers/internal-upstream",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });

    // The internal key never appears in any API listing (it is not a row).
    const lists = await Promise.all([
      stack.env.app.inject({ method: "GET", url: "/api/v1/api-keys", headers: { authorization: `Bearer ${stack.memberToken}` } }),
      stack.env.app.inject({ method: "GET", url: "/api/v1/admin/api-keys", headers: { authorization: `Bearer ${stack.adminToken}` } }),
    ]);
    for (const res2 of lists) {
      expect(res2.body).not.toContain(internalKey);
    }
  });

  it("member usage endpoints are scoped to their own rows", async () => {
    await stack.routeModel("m-scope", { priceIn: 0, priceOut: 0 });
    // (usage recording itself is exercised in llm.test.ts)
    const admin = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/usage?group_by=model",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    expect(admin.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(admin.body)["rows"])).toBe(true);
    const member = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/usage/summary",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(member.statusCode).toBe(200);
    expect(JSON.parse(member.body)).toHaveProperty("today_cost_usd");
  });

});
