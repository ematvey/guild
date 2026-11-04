// The generic `api` tool every REST integration exposes: the full vendor API
// surface beyond the named tools.

import type { IntegrationToolDecl } from "./types.js";

export function apiTool(vendor: string): IntegrationToolDecl {
  return {
    name: "api",
    class: "write",
    description:
      `Call any ${vendor} REST endpoint directly — the full API surface ` +
      "beyond the named tools. Args: method (GET/POST/PATCH/PUT/DELETE, " +
      "default GET), path (starts with /), query (object of strings), " +
      "body (JSON object). Use the named tools for simple lookups; use " +
      "this for filters, associations, batch operations, and anything " +
      "else the API supports.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP method, default GET" },
        path: { type: "string", description: "Endpoint path starting with /" },
        query: { type: "object", description: "Query parameters as strings" },
        body: { type: "object", description: "JSON request body (POST/PATCH/PUT)" },
      },
      required: ["path"],
    },
  };
}
