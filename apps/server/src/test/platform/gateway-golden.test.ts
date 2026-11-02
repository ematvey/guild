// Golden replay: every gateway surface is replayed against fixed captured
// fixtures (the wire contract shipped clients hold), with only dynamic
// values masked (completion ids, created timestamps, uuids, key prefixes,
// upstream URLs, masked-key bullets). JSON bodies compare as parsed values;
// SSE streams compare as parsed frames.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setupGatewayStack, startMockUpstream, type GatewayStack } from "../support/gateway-stack.js";

const gold = (name: string): string => readFileSync(new URL(`./fixtures/golden/${name}`, import.meta.url), "utf8");

/** Masks the dynamic values that legitimately differ between the capture
 *  run and the replay run. */
function mask(text: string): string {
  return (
    text
      .replace(/chatcmpl-[0-9a-f-]{36}/g, "<CMPL>")
      .replace(/msg_[0-9a-f-]{36}/g, "<MSG>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "<TS>")
      .replace(/gk_[0-9a-f]{7}/g, "<PREFIX>")
      .replace(/"created":\d+/g, '"created":"<CREATED>"')
      // The mock upstream's base_url and the masked key length are
      // environment details, not contract.
      .replace(/https?:\/\/[^"]+/g, "<URL>")
      .replace(/•+/g, "<MASKED>")
  );
}

// The captured upstream stream (OpenAI-protocol deltas with reasoning
// content, finish length, and a usage tail) that produced every golden
// fixture below — the mock upstream replays it verbatim.
const CAPTURED_UPSTREAM_SSE =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"reasoning_content":"The"}}]}\n\n' +
  'data: {"choices":[{"delta":{"reasoning_content":" user is asking me to say"}}]}\n\n' +
  'data: {"choices":[{"delta":{"reasoning_content":" exactly \\"hello gateway\\". This"}}]}\n\n' +
  'data: {"choices":[{"delta":{"reasoning_content":" is a simple"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":16}}\n\n' +
  "data: [DONE]\n\n";

// Parses an SSE body into its frames: the optional event name and the parsed
// JSON data (or the literal [DONE] marker).
interface SseFrame {
  event: string | null;
  data: unknown;
}

function parseSse(text: string): SseFrame[] {
  return text
    .trim()
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? null;
      const dataText = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "";
      return { event, data: dataText === "[DONE]" ? "[DONE]" : JSON.parse(dataText) };
    });
}

describe("gateway golden replay (captured fixtures)", () => {
  let stack: GatewayStack;

  it("setup", async () => {
    stack = await setupGatewayStack();
  }, 120_000);

  it("admin catalog, models, api keys, both LLM surfaces, usage — matches the live stack", async () => {
    const inject = (
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      token: string,
      payload?: unknown,
    ): Promise<{ statusCode: number; body: string }> =>
      stack.env.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(payload === undefined ? {} : { payload: payload as object }),
      }) as unknown as Promise<{ statusCode: number; body: string }>;

    // The upstream replays the captured OpenAI-protocol stream for every
    // completion call (the openai stream check expects the verbatim bytes,
    // which already include the finish frame and [DONE] but no usage).
    const upstream = await startMockUpstream([
      { body: CAPTURED_UPSTREAM_SSE },
      { body: gold("openai_stream.txt") },
      { body: CAPTURED_UPSTREAM_SSE },
      { body: CAPTURED_UPSTREAM_SSE },
    ]);

    // Provider: created as slug "openai" (the live stack's seeded slug),
    // renamed to the capture's display name; the slug is stable.
    const provRes = await inject("POST", "/api/v1/admin/gateway/providers", stack.adminToken, {
      name: "openai",
      protocol: "openai",
      base_url: upstream.url,
      key: "sk-live-capture",
    });
    expect(provRes.statusCode).toBe(200);
    const renameRes = await inject("PUT", "/api/v1/admin/gateway/providers/openai", stack.adminToken, {
      name: "Local LLMs",
      protocol: "openai",
      base_url: upstream.url,
      key: "sk-live-capture",
    });
    expect(renameRes.statusCode).toBe(200);

    // Route with the capture's exact route fields.
    const routeRes = await inject("PUT", "/api/v1/admin/gateway/routes", stack.adminToken, {
      model: "GLM-5.3-Flash",
      provider: "openai",
      enabled: true,
      price_in: 0,
      price_out: 0,
      quota_monthly_usd: null,
      reasoning: true,
      context_window: 500000,
      max_output_tokens: null,
      modalities: ["image", "video"],
    });
    expect(routeRes.statusCode).toBe(200);

    // API keys: the harness's setup key is hard-deleted (the capture's
    // member list holds exactly one key), then "key1" (admin-owned, minted
    // first so the list order matches) and "m2-capture" (member-owned).
    await stack.env.db.query("DELETE FROM api_keys WHERE id = $1", [stack.apiKeyId]);
    const key1 = await inject("POST", "/api/v1/api-keys", stack.adminToken, { name: "key1" });
    expect(key1.statusCode).toBe(200);
    const capture = await inject("POST", "/api/v1/api-keys", stack.memberToken, { name: "m2-capture" });
    expect(capture.statusCode).toBe(200);
    // The completion calls run under the admin's key so their usage rows
    // stay out of the member-scoped golden aggregate (the capture's rows
    // were cleaned from the live stack after the run).
    const adminKey = (JSON.parse(key1.body) as { plaintext: string }).plaintext;

    // --- parsed-value replays ---
    const checks: [string, string, string][] = [
      [
        "admin providers",
        (await inject("GET", "/api/v1/admin/gateway/providers", stack.adminToken)).body,
        gold("admin_providers.json"),
      ],
      [
        "admin routes",
        (await inject("GET", "/api/v1/admin/gateway/routes", stack.adminToken)).body,
        gold("admin_routes.json"),
      ],
      ["openai models", (await inject("GET", "/openai/v1/models", adminKey)).body, gold("models.json")],
      [
        "gateway models",
        (await inject("GET", "/api/v1/gateway/models", stack.memberToken)).body,
        gold("user_models.json"),
      ],
      ["user api keys", (await inject("GET", "/api/v1/api-keys", stack.memberToken)).body, gold("user_apikeys.json")],
      [
        "admin api keys",
        (await inject("GET", "/api/v1/admin/api-keys", stack.adminToken)).body,
        gold("admin_apikeys.json"),
      ],
    ];
    for (const [label, actual, expected] of checks) {
      expect(JSON.parse(mask(actual)), label).toEqual(JSON.parse(mask(expected)));
    }

    // OpenAI non-stream: usage (17/16) rides the usage frame the mock
    // appends after the finish frame.
    const openaiRes = await inject("POST", "/openai/v1/chat/completions", adminKey, {
      model: "GLM-5.3-Flash",
      messages: [{ role: "user", content: "Say exactly 'hello gateway'." }],
      max_tokens: 16,
    });
    expect(openaiRes.statusCode).toBe(200);
    expect(JSON.parse(mask(openaiRes.body)), "openai nonstream").toEqual(
      JSON.parse(mask(gold("openai_nonstream.json"))),
    );

    // OpenAI stream: the mock serves the captured stream bytes verbatim
    // (no usage frame — exactly what the live upstream sent).
    const openaiStream = await inject("POST", "/openai/v1/chat/completions", adminKey, {
      model: "GLM-5.3-Flash",
      messages: [{ role: "user", content: "Say exactly 'hello gateway'." }],
      max_tokens: 16,
      stream: true,
    });
    expect(openaiStream.statusCode).toBe(200);
    expect(parseSse(mask(openaiStream.body)), "openai stream").toEqual(parseSse(mask(gold("openai_stream.txt"))));

    // Anthropic surface over the same openai-protocol provider.
    const anthropicRes = await inject("POST", "/anthropic/v1/messages", adminKey, {
      model: "GLM-5.3-Flash",
      messages: [{ role: "user", content: "Say exactly 'hello gateway'." }],
      max_tokens: 16,
    });
    expect(anthropicRes.statusCode).toBe(200);
    expect(JSON.parse(mask(anthropicRes.body)), "anthropic nonstream").toEqual(
      JSON.parse(mask(gold("anthropic_nonstream.json"))),
    );

    const anthropicStream = await inject("POST", "/anthropic/v1/messages", adminKey, {
      model: "GLM-5.3-Flash",
      messages: [{ role: "user", content: "Say exactly 'hello gateway'." }],
      max_tokens: 16,
      stream: true,
    });
    expect(anthropicStream.statusCode).toBe(200);
    expect(parseSse(mask(anthropicStream.body)), "anthropic stream").toEqual(
      parseSse(mask(gold("anthropic_stream.txt"))),
    );

    // Usage: seed the exact aggregate the capture shows (1348 requests,
    // 34320778 tokens in, 716325 out, $0.00 cost).
    await stack.seedUsage({ model: "GLM-5.3-Flash", costUsd: 0, tokensIn: 25459, tokensOut: 532, rows: 1346 });
    await stack.seedUsage({ model: "GLM-5.3-Flash", costUsd: 0, tokensIn: 26482, tokensOut: 253 });
    await stack.seedUsage({ model: "GLM-5.3-Flash", costUsd: 0, tokensIn: 26482, tokensOut: 0 });
    await stack.drain();
    expect(
      JSON.parse(mask((await inject("GET", "/api/v1/usage?group_by=model", stack.memberToken)).body)),
      "usage",
    ).toEqual(JSON.parse(mask(gold("usage.json"))));
    expect(
      JSON.parse(mask((await inject("GET", "/api/v1/usage/summary", stack.memberToken)).body)),
      "usage summary",
    ).toEqual(JSON.parse(mask(gold("usage_summary.json"))));

    // The upstream saw exactly the four completion calls, each pointed at
    // the chat endpoint with the provider key.
    expect(upstream.requests).toHaveLength(4);
    for (const r of upstream.requests) {
      expect(r.path).toBe("/v1/chat/completions");
      expect(r.headers["authorization"]).toBe("Bearer sk-live-capture");
    }
    await upstream.stop();
  });

  it("cleanup", async () => {
    await stack.close();
  }, 60_000);
});
