import { VENDOR_API_MAX_CHARS, secret, pathSegment, fetchJson, clampNumber, callVendorApi, langfuseBaseUrl } from "./shared.js";
import type { ToolOutcome, Json } from "./shared.js";

// ---------- langfuse ----------

async function langfuseGet(base: string, path: string, publicKey: string, secretKey: string): Promise<Json> {
  const basic = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return fetchJson(`${base}${path}`, { headers: { authorization: `Basic ${basic}` } }, "langfuse");
}

export async function langfuseExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const publicKey = secret(secrets, "public_key");
  const secretKey = secret(secrets, "secret_key");
  const base = langfuseBaseUrl(config, secrets);
  switch (tool) {
    case "list_traces": {
      const limit = clampNumber(args, "limit", 10, 50);
      const body = await langfuseGet(base, `/api/public/traces?limit=${limit}`, publicKey, secretKey);
      const traces = Array.isArray(body["data"]) ? (body["data"] as Json[]) : [];
      let content = "";
      for (const [i, trace] of traces.slice(0, limit).entries()) {
        const id = typeof trace["id"] === "string" ? trace["id"] : "?";
        const name = typeof trace["name"] === "string" ? trace["name"] : "(unnamed)";
        const timestamp = typeof trace["timestamp"] === "string" ? trace["timestamp"] : "";
        content += `${i + 1}. ${id} ${name} ${timestamp}\n`;
      }
      if (content === "") content = "No traces.";
      return { content, meta: { card: "langfuse", kind: "traces", count: Math.min(traces.length, limit) } };
    }
    case "get_trace": {
      const traceId = args["trace_id"];
      if (typeof traceId !== "string") throw new Error("get_trace requires trace_id");
      const trace = await langfuseGet(base, `/api/public/traces/${pathSegment(traceId)}`, publicKey, secretKey);
      return {
        content: JSON.stringify(trace, null, 2),
        meta: { card: "langfuse", kind: "trace", id: trace["id"] ?? null },
      };
    }
    case "get_prompt": {
      const name = args["name"];
      if (typeof name !== "string") throw new Error("get_prompt requires name");
      // The prompt name is a path segment (folder names carry `/`):
      // encoded, so it cannot escape the segment or carry `?`/`#`.
      const version = typeof args["version"] === "number" && Number.isFinite(args["version"]) ? Math.trunc(args["version"]) : null;
      const path = version !== null
        ? `/api/public/v2/prompts/${pathSegment(name)}?version=${version}`
        : `/api/public/v2/prompts/${pathSegment(name)}`;
      const body = await langfuseGet(base, path, publicKey, secretKey);
      const promptName = typeof body["name"] === "string" ? body["name"] : name;
      const promptVersion = typeof body["version"] === "number" ? body["version"] : 0;
      const kind = typeof body["type"] === "string" ? body["type"] : "text";
      return {
        content: `${promptName} v${promptVersion} (${kind})\n\n${JSON.stringify(body["prompt"] ?? null, null, 2)}`,
        meta: { card: "langfuse", kind: "prompt", name: promptName, version: promptVersion },
      };
    }
    case "api":
      return callVendorApi(base, { kind: "basic", user: publicKey, pass: secretKey }, args, VENDOR_API_MAX_CHARS, []);
    default:
      throw new Error(`langfuse integration has no tool ${tool}`);
  }
}

