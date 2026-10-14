// LLM gateway endpoint suites: the OpenAI and Anthropic wire shapes (both
// streaming modes) against a scripted mock upstream, usage recording into
// the disposable ClickHouse, upstream request-body contracts, and the
// client-disconnect billing path.

import { describe, expect, it } from "vitest";
import { startMockUpstream, setupM2Stack, type M2Stack } from "./m2-harness.js";

describe("M2 LLM gateway endpoints", () => {
  let stack: M2Stack;
  // Shared stack (setup in beforeAll via the module-level hooks below).

  it("setup", async () => {
    stack = await setupM2Stack();
  }, 120_000);

  it("openai non-stream: text + usage recorded with key-owner attribution", async () => {
    await stack.routeModel("m1");
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: {
        model: "m1",
        messages: [{ role: "user", content: "weather?" }],
        max_tokens: 77,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, any>;
    expect(body["object"]).toBe("chat.completion");
    expect(body["model"]).toBe("m1");
    expect(body["id"]).toMatch(/^chatcmpl-[0-9a-f-]{36}$/);
    expect(body["choices"][0]["message"]).toMatchObject({ role: "assistant", content: "hello" });
    expect(body["choices"][0]["finish_reason"]).toBe("stop");
    expect(body["usage"]).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

    // The upstream request: bearer key, streamed openai body, dialect max_tokens.
    const upstream = stack.mock.requests[0]!;
    expect(upstream.path).toBe("/v1/chat/completions");
    expect(upstream.headers["authorization"]).toBe("Bearer sk-mock");
    expect(upstream.body["model"]).toBe("m1");
    expect(upstream.body["stream"]).toBe(true);
    expect(upstream.body["stream_options"]).toEqual({ include_usage: true });
    expect(upstream.body["max_tokens"]).toBe(77);
    expect(upstream.body["messages"]).toEqual([{ role: "user", content: "weather?" }]);

    await stack.drain();
    const rows = await stack.usageRows();
    const row = rows.find((r) => r["model"] === "m1");
    expect(row).toBeDefined();
    expect(row!["tokens_in"]).toBe(3);
    expect(row!["tokens_out"]).toBe(2);
    // Key owner attribution: the member who minted the key.
    const owner = await stack.env.db.query<{ id: string }>(
      "SELECT u.id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = $1",
      [stack.apiKeyId],
    );
    expect(row!["user_id"]).toBe(owner.rows[0]!.id);
    expect(row!["session_id"]).toBe(stack.apiKeyId);
    // cost = (3/1e6)*2.0 + (2/1e6)*4.0 = 0.000014
    expect(Number(row!["cost_usd"])).toBeCloseTo(0.000014, 10);
  });

  it("openai reasoning replay: reasoning_content rides in and out", async () => {
    await stack.routeModel("m-reason");
    const scripted = await startMockUpstream([
      {
        body:
          'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
          'data: {"choices":[{"delta":{"reasoning_content":"more","content":"!"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n' +
          "data: [DONE]\n\n",
      },
    ]);
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-reason", provider: "mock-openai", price_in: 0, price_out: 0 },
    });
    // Repoint the provider at the scripted upstream via a second provider.
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "Reason Upstream", protocol: "openai", base_url: scripted.url, key: "sk" },
    });
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-reason", provider: "reason-upstream", price_in: 0, price_out: 0 },
    });

    // Ingress reasoning on an assistant turn reaches the upstream wire.
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: {
        model: "m-reason",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "old", reasoning_content: "prior thought" },
          { role: "user", content: "again" },
        ],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    // Stream frames: role frame, reasoning, content, mixed, final, [DONE].
    // Each provider chunk becomes its own SSE frame (Rust emits one
    // chat.completion.chunk per parsed delta chunk).
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => f.slice(6));
    expect(frames[0]).toContain('"role":"assistant"');
    expect(frames[1]).toContain('"reasoning_content":"thinking hard"');
    expect(frames[2]).toContain('"content":"answer"');
    expect(frames[3]).toContain('"reasoning_content":"more"');
    expect(frames[4]).toContain('"content":"!"');
    expect(frames.at(-2)).toContain('"finish_reason":"stop"');
    expect(frames.at(-1)).toBe("[DONE]");
    const upstream = scripted.requests[0]!;
    const replayed = upstream.body["messages"] as Record<string, unknown>[];
    expect(replayed[1]!["reasoning_content"]).toBe("prior thought");
    await scripted.stop();
  });

  it("openai tool round trip: arguments unpacked in, raw-buffer preserved out", async () => {
    const scripted = await startMockUpstream([
      {
        body:
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"get_weather","arguments":"{\\"city\\":\\\"oslo\\""}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
          "data: [DONE]\n\n",
      },
      {
        body:
          'data: {"choices":[{"delta":{"content":"sunny"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
          "data: [DONE]\n\n",
      },
    ]);
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "Tool Upstream", protocol: "openai", base_url: scripted.url, key: "sk" },
    });
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-tools", provider: "tool-upstream", price_in: 2, price_out: 4 },
    });

    // Turn 1: non-stream, model requests a tool call (no usage frame →
    // total 0).
    const t1 = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: {
        model: "m-tools",
        messages: [{ role: "user", content: "weather in oslo?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        max_completion_tokens: 123,
      },
    });
    expect(t1.statusCode).toBe(200);
    const b1 = JSON.parse(t1.body) as Record<string, any>;

    expect(b1["choices"][0]["finish_reason"]).toBe("tool_calls");
    const tc = b1["choices"][0]["message"]["tool_calls"][0];
    expect(tc["id"]).toBe("call_x");
    expect(tc["type"]).toBe("function");
    expect(tc["function"]["name"]).toBe("get_weather");
    // Folded partial arguments parse into a sorted-key object string.
    expect(tc["function"]["arguments"]).toBe('{"city":"oslo"}');
    expect(b1["usage"]["total_tokens"]).toBe(0);
    const up1 = scripted.requests[0]!;
    // The limit rides the dialect field for the model name ("m-tools" is
    // not a reasoning family → max_tokens).
    expect(up1.body["max_tokens"]).toBe(123);
    expect((up1.body["tools"] as unknown[])[0]).toMatchObject({
      type: "function",
      function: { name: "get_weather", parameters: { type: "object" } },
    });

    // Turn 2: tool result + system message ride the wire in order.
    const t2 = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: {
        model: "m-tools",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":"oslo"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: [{ type: "text", text: "snow" }] },
        ],
      },
    });
    expect(t2.statusCode).toBe(200);
    const up2 = scripted.requests[1]!;
    const msgs = up2.body["messages"] as Record<string, unknown>[];
    expect(msgs.map((m) => m["role"])).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[1]!["content"]).toBe("weather?");
    const replayCalls = msgs[2]!["tool_calls"] as Record<string, unknown>[];
    expect((replayCalls[0]!["function"] as Record<string, unknown>)["arguments"]).toBe('{"city":"oslo"}');
    expect(msgs[3]!["tool_call_id"]).toBe("call_x");
    expect(msgs[3]!["content"]).toBe("snow");
        const b2 = JSON.parse(t2.body) as Record<string, any>;
    expect(b2["choices"][0]["message"]["content"]).toBe("sunny");
    expect(b2["usage"]["prompt_tokens"]).toBe(5);
    await scripted.stop();
  });

  it("anthropic non-stream: blocks, stop reasons, tool_result ordering, image sources", async () => {
    const scripted = await startMockUpstream([
      {
        body:
          'data: {"type":"message_start","message":{"usage":{"input_tokens":13}}}\n\n' +
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"checking"}}\n\n' +
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n' +
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"oslo\\"}"}}\n\n' +
          'data: {"type":"content_block_stop","index":1}\n\n' +
          'data: {"type":"content_block_stop","index":0}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n' +
          'data: {"type":"message_stop"}\n\n',
      },
    ]);
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "Anthropic Upstream", protocol: "anthropic", base_url: scripted.url, key: "sk" },
    });
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-claude", provider: "anthropic-upstream", price_in: 2, price_out: 4 },
    });

    const res = await stack.env.app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": stack.apiKey, "content-type": "application/json" },
      payload: {
        model: "m-claude",
        system: [{ type: "text", text: "be terse" }, { type: "text", text: "and kind" }],
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "checking" },
              { type: "tool_use", id: "call_x", name: "get_weather", input: { city: "oslo" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_x", content: "snow" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              { type: "text", text: "what next?" },
            ],
          },
        ],
        max_tokens: 64,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, any>;
    expect(body["type"]).toBe("message");
    expect(body["id"]).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(body["stop_reason"]).toBe("tool_use");
    expect(body["stop_sequence"]).toBeNull();
    expect(body["usage"]).toEqual({ input_tokens: 13, output_tokens: 7 });

    // The upstream body: anthropic protocol shape.
    const upstream = scripted.requests[0]!;
    expect(upstream.path).toBe("/v1/messages");
    expect(upstream.headers["x-api-key"]).toBe("sk");
    expect(upstream.headers["anthropic-version"]).toBe("2023-06-01");
    expect(upstream.body["max_tokens"]).toBe(64);
    expect(upstream.body["system"]).toBe("be terse\nand kind");
    const msgs = upstream.body["messages"] as Record<string, unknown>[];
    // Assistant tool_use turn; the [tool_result, image, text] user
    // continuation rides ONE user content array.
    expect((msgs[1]!["content"] as unknown[]).map((b) => (b as Record<string, unknown>)["type"])).toEqual(["text", "tool_use"]);
    expect((msgs[1]!["content"] as Record<string, unknown>[])[1]!["input"]).toEqual({ city: "oslo" });
    const lastBlocks = msgs[2]!["content"] as Record<string, unknown>[];
    // The adapter emits the turn's text before its images (the internal
    // Message keeps text and image lists separate).
    expect(lastBlocks.map((b) => b["type"])).toEqual(["tool_result", "text", "image"]);
    expect(lastBlocks[0]!["tool_use_id"]).toBe("call_x");
    expect(lastBlocks[1]!["text"]).toBe("what next?");
    expect(lastBlocks[2]!["source"]).toEqual({ type: "base64", media_type: "image/png", data: "AAAA" });
    await scripted.stop();
  });

  it("anthropic stream: event cadence matches the Anthropic contract", async () => {
    const scripted = await startMockUpstream([
      {
        body:
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sunny"}}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
          'data: {"type":"message_stop"}\n\n',
      },
    ]);
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "Anthropic Stream Upstream", protocol: "anthropic", base_url: scripted.url, key: "sk" },
    });
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-claude-s", provider: "anthropic-stream-upstream", price_in: 0, price_out: 0 },
    });

    const res = await stack.env.app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": stack.apiKey, "content-type": "application/json" },
      payload: { model: "m-claude-s", messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.body
      .split("\n\n")
      .filter((f) => f.startsWith("event: "))
      .map((f) => ({
        name: f.split("\n")[0]!.slice("event: ".length),
        data: JSON.parse(f.split("\n")[1]!.slice("data: ".length)) as Record<string, unknown>,
      }));
    expect(events.map((e) => e.name)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]!.data["message"]).toMatchObject({ role: "assistant", content: [] });
    expect(events[4]!.data["usage"]).toEqual({ output_tokens: 3, input_tokens: 5 });
    expect((events[4]!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("end_turn");
    await stack.drain();
    const rows = await stack.usageRows();
    const row = rows.find((r) => r["model"] === "m-claude-s");
    expect(row).toBeDefined();
    expect(row!["tokens_in"]).toBe(5);
    expect(row!["tokens_out"]).toBe(3);
    await scripted.stop();
  });

  it("usage is recorded for streaming openai completions too", async () => {
    await stack.routeModel("m-stream", { priceIn: 0, priceOut: 0 });
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: { model: "m-stream", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    await stack.drain();
    const rows = await stack.usageRows();
    expect(rows.find((r) => r["model"] === "m-stream")).toBeDefined();
  });

  it("zero-token guard: provider error before the first frame records nothing", async () => {
    const scripted = await startMockUpstream([{ status: 500, contentType: "text/plain", body: "boom" }]);
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "Dead Upstream", protocol: "openai", base_url: scripted.url, key: "sk" },
    });
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-dead", provider: "dead-upstream", price_in: 1, price_out: 1 },
    });
    const before = (await stack.usageRows()).length;
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: { model: "m-dead", messages: [{ role: "user", content: "hi" }] },
    });
    // 401 → provider auth error class (mock returns 500 — upstream error).
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)["error"]).toMatchObject({ type: "invalid_request_error" });
    await stack.drain();
    expect(await stack.usageRows()).toHaveLength(before);
    // The Anthropic surface renders the same failure as api_error.
    const resA = await stack.env.app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": stack.apiKey, "content-type": "application/json" },
      payload: { model: "m-dead", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    });
    expect(resA.statusCode).toBe(502);
    expect(JSON.parse(resA.body)["error"]["type"]).toBe("api_error");
    await scripted.stop();
  });

  it("an in-stream provider error still bills (a request was served)", async () => {
    const scripted = await startMockUpstream([
      {
        body:
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
          'data: {"error":{"message":"mid-stream failure"}}\n\n',
      },
    ]);
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/admin/gateway/providers",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { name: "Midstream Upstream", protocol: "openai", base_url: scripted.url, key: "sk" },
    });
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      payload: { model: "m-midstream", provider: "midstream-upstream", price_in: 0, price_out: 0 },
    });
    const before = (await stack.usageRows()).length;
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${stack.apiKey}`, "content-type": "application/json" },
      payload: { model: "m-midstream", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    // The upstream failure surfaces with the ProviderError Display prefix.
    expect(res.body).toContain('"error":{"message":"provider error: mid-stream failure","type":"provider_error"}');
    await stack.drain();
    const rows = await stack.usageRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!["model"]).toBe("m-midstream");
    await scripted.stop();
  });

  it("audio input is rejected on anthropic-protocol routes before the upstream call", async () => {
    const { anthropicProvider } = await import("../../platform/provider/anthropic.js");
    const { startMockUpstream: startMock } = await import("./m2-harness.js");
    const upstream = await startMock([{ body: 'data: {"type":"message_stop"}\n\n' }]);
    let error: Error | null = null;
    try {
      await anthropicProvider.chatStream({
        model: "m",
        system: null,
        messages: [
          {
            role: "user",
            content: "listen",
            images: [],
            audio: [{ data: "QUJD", format: "wav" }],
          },
        ],
        apiKey: "k",
        baseUrl: upstream.url,
        tools: null,
        maxTokens: 0,
      });
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("not supported");
    // The rejected request never reached the upstream.
    expect(upstream.requests).toHaveLength(0);
    await upstream.stop();
  });

  it("cleanup", async () => {
    await stack.close();
  }, 60_000);
});
