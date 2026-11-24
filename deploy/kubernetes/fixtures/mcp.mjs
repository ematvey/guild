const tools = ["echo_allowed", "echo_denied"].map((name) => ({
  name,
  description: "Echo a fixture string",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: { readOnlyHint: true },
}));

Bun.serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/healthz") return new Response("ok");
    const authorized = (kind, value) => req.headers.get("authorization") === `${kind} ${value}`;
    const basic = (account, credential) => authorized("Basic", Buffer.from(`${account}:${credential}`).toString("base64"));
    const unauthorized = () => new Response(null, { status: 401 });
    if (path === "/rest/api/3/search/jql" && req.method === "POST") {
      if (!basic("fixture@example.org", "fixture-atlassian-token") || (await req.json()).jql !== "project = GUILD") return unauthorized();
      return Response.json({ issues: [{ key: "GUILD-1", fields: { summary: "Fixture issue" } }] });
    }
    if (path === "/v1/search" && req.method === "POST") {
      if (!authorized("Bearer", "fixture-firecrawl-token") || (await req.json()).query !== "guild") return unauthorized();
      return Response.json({ success: true, data: [{ title: "Guild fixture result", url: "https://example.org/guild" }] });
    }
    if (path === "/v1/scrape" && req.method === "POST") {
      if (!authorized("Bearer", "fixture-firecrawl-token") || (await req.json()).url !== "https://example.org/") return unauthorized();
      return Response.json({ success: false, error: "fixture rejected scrape" }, { status: 422 });
    }
    if (path === "/search/repositories" && req.method === "GET") {
      if (!authorized("Bearer", "fixture-github-token") || url.searchParams.get("q") !== "guild") return unauthorized();
      return Response.json({ total_count: 1, items: [{ full_name: "fixture/guild" }] });
    }
    if (path === "/crm/v3/objects/contacts/search" && req.method === "POST") {
      if (!authorized("Bearer", "fixture-hubspot-token") || (await req.json()).query !== "Guild") return unauthorized();
      return Response.json({ total: 1, results: [{ id: "1", properties: { email: "fixture@example.org" } }] });
    }
    if (path === "/api/public/traces" && req.method === "GET") {
      if (!basic("fixture-langfuse-public", "fixture-langfuse-secret") || url.searchParams.get("limit") !== "1") return unauthorized();
      return Response.json({ data: [{ id: "1", name: "Guild fixture trace" }] });
    }
    if (path === "/conversations.list" && req.method === "GET") {
      if (!authorized("Bearer", "fixture-slack-token") || url.searchParams.get("limit") !== "1") return unauthorized();
      return Response.json({ ok: true, channels: [{ id: "C1", name: "guild-fixture" }] });
    }
    if (path === "/api/v4/projects" && req.method === "GET") {
      if (req.headers.get("private-token") !== "fixture-gitlab-token" ||
          url.searchParams.get("membership") !== "true" || url.searchParams.get("search") !== "guild") {
        return new Response(null, { status: 401 });
      }
      return Response.json([{ name: "Guild fixture project", path_with_namespace: "fixture/guild" }]);
    }
    if (path === "/api/datasources" && req.method === "GET") {
      if (req.headers.get("authorization") !== "Bearer fixture-grafana-token" ||
          req.headers.get("x-grafana-org-id") !== "7") return new Response(null, { status: 401 });
      return Response.json([{ name: "Guild fixture metrics", type: "prometheus", uid: "guild-metrics" }]);
    }
    if (path === "/api/projects/1/query/" && req.method === "POST") {
      if (req.headers.get("authorization") !== "Bearer fixture-posthog-token") {
        return new Response(null, { status: 401 });
      }
      const { query } = await req.json();
      if (query?.kind !== "HogQLQuery" || query.query !== "SELECT 1 AS guild_fixture") {
        return new Response(null, { status: 400 });
      }
      return Response.json({ columns: ["guild_fixture"], results: [[1]] });
    }
    if (path === "/search" && url.searchParams.get("format") === "json") {
      return Response.json({ results: [{
        title: "SearXNG fixture", url: "https://example.org/result",
        content: `query: ${url.searchParams.get("q")}`,
      }] });
    }
    if (path === "/google-token" && req.method === "POST") {
      const assertion = new URLSearchParams(await req.text()).get("assertion");
      const claim = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
      if (claim.sub !== "experiment@example.org" || claim.iss !== "fixture-service@example.org") {
        return Response.json({ error: "unexpected delegated identity" }, { status: 403 });
      }
      return Response.json({ access_token: "fixture-google-token", expires_in: 3600 });
    }
    if (path === "/drive/v3/files/fixture-file") {
      if (req.headers.get("authorization") !== "Bearer fixture-google-token") return new Response(null, { status: 401 });
      if (url.searchParams.get("alt") === "media") return new Response(new Uint8Array([0, 255, 71, 85, 73, 76, 68]));
      return Response.json({ name: "probe.bin", mimeType: "application/octet-stream" });
    }
    if (!["/mcp", "/envelope", "/stripe-mcp"].includes(path) || req.method !== "POST") return new Response(null, { status: 405 });
    if (path === "/stripe-mcp") {
      if (!authorized("Bearer", "fixture-stripe-key") ||
          req.headers.get("stripe-account") !== "acct_fixture" || req.headers.has("x-guild-org")) return unauthorized();
    } else if (path === "/envelope") {
      if (req.headers.has("authorization") ||
          req.headers.get("x-guild-org") !== "00000000-0000-4000-8000-000000000024" ||
          req.headers.get("x-guild-caller") !== "00000000-0000-4000-8000-000000000025" ||
          req.headers.get("x-guild-secret-token") !== "fixture-envelope-key" ||
          !/^[a-f0-9-]{36}$/.test(req.headers.get("x-guild-call-id") ?? "")) {
        return new Response(null, { status: 401 });
      }
    } else if (req.headers.get("authorization") !== "Bearer fixture-mcp-key" &&
        req.headers.get("x-fixture-mcp-token") !== "fixture-private-token") {
      return new Response(null, { status: 401 });
    }
    const body = await req.json();
    if (path === "/envelope" && body.method === "tools/call" &&
        req.headers.get("x-guild-acting-as") !== "migration-owner@example.org") {
      return new Response(null, { status: 401 });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") {
      return reply({ protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
    }
    if (body.method === "tools/list") return reply({ tools });
    if (body.method === "tools/call" && tools.some(({ name }) => name === body.params.name)) {
      return reply({ content: [{ type: "text", text: body.params.arguments.text }] });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method or tool" } });
  },
});
