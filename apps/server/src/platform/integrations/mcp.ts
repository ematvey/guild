// Minimal MCP streamable-HTTP client (crates/server/src/worker/mcp_pool.rs
// + rmcp): exactly the surface the integration routes need — the initialize
// handshake with the identity envelope and secret headers, and tools/list.
// Tool CALLS are not ported: the integrations runtime is deferred (spec
// decision 8), and a validated execute call fails before any MCP peer is
// contacted.

type Json = Record<string, unknown>;

const CONNECT_TIMEOUT_MS = 10_000;
/** rmcp's default request timeout. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface McpTool {
  name: string;
  description: string;
  /** The tool's JSON Schema input. */
  inputSchema: unknown;
}

export interface McpPeer {
  listTools(): Promise<McpTool[]>;
}

function parseSseData(chunk: string): Json[] {
  return chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Json;
      } catch {
        return null;
      }
    })
    .filter((v): v is Json => v !== null);
}

/** Reads a JSON-RPC response that may arrive as plain JSON or as an SSE
 *  stream (the streamable-HTTP transport allows both). */
async function readRpcResponse(res: Response, requestId: number): Promise<Json> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let messages: Json[];
  if (contentType.includes("text/event-stream")) {
    messages = parseSseData(text);
  } else {
    try {
      messages = [JSON.parse(text) as Json];
    } catch {
      throw new Error("mcp transport returned a non-JSON body");
    }
  }
  const reply = messages.find((m) => m["id"] === requestId);
  if (reply === undefined) throw new Error("mcp response missing the request id");
  if (reply["error"] !== null && reply["error"] !== undefined) {
    const err = reply["error"] as Json;
    throw new Error(`mcp error ${err["code"]}: ${String(err["message"] ?? "unknown")}`);
  }
  const result = reply["result"];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("mcp response missing result");
  }
  return result as Json;
}

function rpcRequest(id: number, method: string, params: Json): Json {
  return { jsonrpc: "2.0", id, method, params };
}

/**
 * Connects to an MCP server over the streamable-HTTP transport and completes
 * the initialize handshake with the given headers (the identity envelope and
 * secret headers ride on the transport, same as the Rust pool). A timeout
 * fails with the Rust pool's "mcp connect timed out"; every other transport
 * or handshake failure surfaces as "mcp handshake failed: <detail>".
 */
export async function mcpConnect(url: string, headers: Record<string, string>): Promise<McpPeer> {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  let sessionId: string | null = null;
  const post = async (body: Json): Promise<Response> => {
    const allHeaders: Record<string, string> = { ...baseHeaders };
    if (sessionId !== null) allHeaders["mcp-session-id"] = sessionId;
    return fetch(url, {
      method: "POST",
      headers: allHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  // initialize
  let initRes: Response;
  try {
    initRes = await fetch(url, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(rpcRequest(0, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "guild", version: "0.1.0" },
      })),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("mcp connect timed out");
    }
    const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new Error(`mcp handshake failed: ${cause}`);
  }
  if (!initRes.ok) {
    throw new Error(`mcp handshake failed: server returned ${initRes.status}`);
  }
  const sid = initRes.headers.get("mcp-session-id");
  if (sid !== null) sessionId = sid;
  await readRpcResponse(initRes, 0);

  // notifications/initialized
  const initializedRes = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  if (!initializedRes.ok && initializedRes.status !== 202) {
    throw new Error(`mcp handshake failed: initialized notification rejected (${initializedRes.status})`);
  }
  // Drain the body so the socket is reusable.
  await initializedRes.text().catch(() => "");

  return {
    async listTools(): Promise<McpTool[]> {
      const res = await post(rpcRequest(1, "tools/list", {}));
      if (!res.ok) {
        throw new Error(`mcp tools/list failed: server returned ${res.status}`);
      }
      const result = await readRpcResponse(res, 1);
      const tools = result["tools"];
      if (!Array.isArray(tools)) throw new Error("mcp tools/list result missing tools");
      return tools.map((t) => {
        const tool = t as Json;
        const description = typeof tool["description"] === "string" ? tool["description"] : "";
        return {
          name: String(tool["name"] ?? ""),
          description,
          inputSchema: tool["inputSchema"] ?? {},
        };
      });
    },
  };
}
