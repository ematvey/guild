import { createPublicKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { delegatedIdentity } from "./integrations/connector-mcp-identity.js";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    maxRequestBodySize: number;
    fetch(request: Request): Promise<Response>;
  }): unknown;
};

const root = "/run/guild-mcp";
const { endpoint, credentials } = JSON.parse(await readFile(`${root}/settings.json`, "utf8")) as {
  endpoint: string;
  credentials: Record<string, string>;
};
const upstream = new URL(endpoint);
if (upstream.username || upstream.password || upstream.hash ||
    (upstream.protocol !== "https:" &&
      !(upstream.protocol === "http:" && upstream.hostname.endsWith(".svc.cluster.local")))) {
  throw new Error("legacy MCP upstream must use HTTPS or be an internal Kubernetes Service");
}
const org = process.env.GUILD_MCP_ORG;
const issuer = process.env.GUILD_MCP_ISSUER;
const key = createPublicKey(await readFile(`${root}/issuer.pem`));
if (!org || !issuer || key.asymmetricKeyType !== "rsa") throw new Error("invalid MCP proxy identity configuration");

const requestHeaders = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const responseHeaders = ["content-type", "cache-control", "mcp-session-id", "mcp-protocol-version", "retry-after"];
const upstreamCredentials = new Headers(credentials);
Bun.serve({
  hostname: "0.0.0.0",
  port: 8080,
  maxRequestBodySize: 4 * 1024 * 1024,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (path !== "/mcp") return new Response(null, { status: 404 });
    if (!["GET", "POST", "DELETE"].includes(request.method)) return new Response(null, { status: 405 });
    const identity = delegatedIdentity(request.headers.get("authorization") ?? "", key, issuer, org);
    if (identity === null) return new Response(null, { status: 401 });
    const headers = new Headers(upstreamCredentials);
    for (const name of requestHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("x-guild-org", org);
    headers.set("x-guild-call-id", randomUUID());
    headers.set("x-guild-caller", identity.memberId);
    if (identity.actingAs !== null) headers.set("x-guild-acting-as", identity.actingAs);
    try {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "error",
        signal: request.signal,
      });
      const outgoing = new Headers();
      for (const name of responseHeaders) {
        const value = response.headers.get(name);
        if (value !== null) outgoing.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers: outgoing });
    } catch {
      return new Response(null, { status: 502 });
    }
  },
});
