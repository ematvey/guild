// Fixture MCP streamable-HTTP server for tests + E2E: plain node, no deps.
// Exposes two tools — echo ({text} → echoes) and add ({a,b} → sum) — over
// the initialize → tools/list → tools/call handshake the Guild mcpConnect
// client speaks. Standalone: `node apps/server/src/test/fixtures/mcp-server.mjs
// --port 8765` (prints the port it bound; port 0 = ephemeral).

import { createServer } from "node:http";

function jsonReply(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Adds two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function callTool(params) {
  const name = params?.name ?? "";
  const args = params?.arguments ?? {};
  if (name === "echo") {
    return {
      content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }],
      isError: false,
    };
  }
  if (name === "add") {
    return {
      content: [{ type: "text", text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }],
      isError: false,
    };
  }
  return {
    content: [{ type: "text", text: `unknown tool ${name}` }],
    isError: true,
  };
}

export async function startMcpFixtureServer(port = 0, host = "127.0.0.1") {
  const sessions = new Set();
  let nextId = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = null;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }));
        return;
      }
      const isNotification = msg.id === undefined || msg.id === null;
      const method = msg.method ?? "";
      if (method === "initialize") {
        const sid = `sess-${nextId++}`;
        sessions.add(sid);
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sid });
        res.end(jsonReply(msg.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "guild-fixture-mcp", version: "0.1.0" },
        }));
        return;
      }
      const sid = req.headers["mcp-session-id"];
      if (typeof sid !== "string" || !sessions.has(sid)) {
        const status = isNotification ? 202 : 200;
        res.writeHead(status, { "content-type": "application/json" });
        if (isNotification) res.end();
        else {
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "unknown session" },
          }));
        }
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonReply(msg.id, { tools: TOOLS }));
        return;
      }
      if (method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonReply(msg.id, callTool(msg.params)));
        return;
      }
      if (isNotification) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method not found: ${method}` },
      }));
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) {
  const argIdx = process.argv.indexOf("--port");
  const port = argIdx >= 0 ? Number(process.argv[argIdx + 1] ?? "0") : 0;
  const server = await startMcpFixtureServer(Number.isFinite(port) ? port : 0);
  const addr = server.address();
  console.log(`mcp fixture server listening on port ${addr.port}`);
}
