// Minimal MCP streamable-HTTP client: exactly the surface the integration
// routes need — the initialize
// handshake with the identity envelope and secret headers, tools/list, and
// tools/call (the tool call maps the peer's content blocks to the
// integration outcome contract, mcp_call_tool).

import type { JsonObject } from "./shared.js";

const CONNECT_TIMEOUT_MS = 10_000;
/** rmcp's default request timeout. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface McpTool {
  name: string;
  description: string;
  /** The tool's JSON Schema input. */
  inputSchema: unknown;
}

export interface McpToolResult {
  /** The joined text of the result's text content blocks. */
  content: string;
  isError: boolean;
}

export interface McpPeer {
  listTools(): Promise<McpTool[]>;
  /** tools/call with the raw (un-namespaced) tool name; the result maps
   *  through the mcp_call_tool contract (text blocks joined with \n; an
   *  error flag surfaces as isError, never as a thrown transport error). */
  callTool(tool: string, args: JsonObject): Promise<McpToolResult>;
}

function parseSseData(chunk: string): JsonObject[] {
  return chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonObject;
      } catch {
        return null;
      }
    })
    .filter((v): v is JsonObject => v !== null);
}

/** Reads a JSON-RPC response that may arrive as plain JSON or as an SSE
 *  stream (the streamable-HTTP transport allows both). */
async function readRpcResponse(res: Response, requestId: number): Promise<JsonObject> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let messages: JsonObject[];
  if (contentType.includes("text/event-stream")) {
    messages = parseSseData(text);
  } else {
    try {
      messages = [JSON.parse(text) as JsonObject];
    } catch {
      throw new Error("mcp transport returned a non-JSON body");
    }
  }
  const reply = messages.find((m) => m["id"] === requestId);
  if (reply === undefined) throw new Error("mcp response missing the request id");
  if (reply["error"] !== null && reply["error"] !== undefined) {
    const err = reply["error"] as JsonObject;
    throw new Error(`mcp error ${err["code"]}: ${String(err["message"] ?? "unknown")}`);
  }
  const result = reply["result"];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("mcp response missing result");
  }
  return result as JsonObject;
}

function rpcRequest(id: number, method: string, params: JsonObject): JsonObject {
  return { jsonrpc: "2.0", id, method, params };
}

/**
 * Connects to an MCP server over the streamable-HTTP transport and completes
 * the initialize handshake with the given headers (the identity envelope and
 * secret headers ride on the transport). A timeout fails with "mcp connect
 * timed out"; every other transport
 * or handshake failure surfaces as "mcp handshake failed: <detail>".
 */
export async function mcpConnect(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<McpPeer> {
  signal?.throwIfAborted();
  const bounded = (ms: number) => signal === undefined
    ? AbortSignal.timeout(ms)
    : AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  let sessionId: string | null = null;
  const post = async (body: JsonObject): Promise<Response> => {
    signal?.throwIfAborted();
    const allHeaders: Record<string, string> = { ...baseHeaders };
    if (sessionId !== null) allHeaders["mcp-session-id"] = sessionId;
    return fetch(url, {
      method: "POST",
      headers: allHeaders,
      body: JSON.stringify(body),
      signal: bounded(REQUEST_TIMEOUT_MS),
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
      signal: bounded(CONNECT_TIMEOUT_MS),
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

  let nextId = 2;
  return {
    async callTool(tool: string, args: JsonObject): Promise<McpToolResult> {
      const id = nextId++;
      const params: JsonObject = { name: tool };
      if (args !== null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length > 0) {
        params["arguments"] = args;
      }
      let res: Response;
      try {
        res = await post(rpcRequest(id, "tools/call", params));
      } catch (error) {
        const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
        throw new Error(`mcp tool call failed: ${cause}`);
      }
      if (!res.ok) {
        throw new Error(`mcp tool call failed: server returned ${res.status}`);
      }
      const result = await readRpcResponse(res, id);
      // Content blocks: text blocks join with \n (mcp_call_tool); non-text
      // blocks carry no model-facing text here.
      const blocks = result["content"];
      const text = Array.isArray(blocks)
        ? blocks
            .map((b) => (b !== null && typeof b === "object" && (b as JsonObject)["type"] === "text" ? String((b as JsonObject)["text"] ?? "") : null))
            .filter((t): t is string => t !== null)
            .join("\n")
        : "";
      const isError = result["isError"] === true;
      return { content: text, isError };
    },

    async listTools(): Promise<McpTool[]> {
      const res = await post(rpcRequest(1, "tools/list", {}));
      if (!res.ok) {
        throw new Error(`mcp tools/list failed: server returned ${res.status}`);
      }
      const result = await readRpcResponse(res, 1);
      const tools = result["tools"];
      if (!Array.isArray(tools)) throw new Error("mcp tools/list result missing tools");
      return tools.map((t) => {
        const tool = t as JsonObject;
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
