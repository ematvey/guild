// The generic `api` tool every REST integration exposes: the full vendor API
// surface beyond the named tools.

import type { IntegrationToolDecl } from "./types.js";

/** How far the tool reaches. Omitted, the tool claims the full API surface
 *  and counts as a write. An integration whose credential carries a fixed
 *  scope set states it here, so the model is not promised more than the
 *  credential can do. */
export interface ApiToolScope {
  /** The scopes the credential carries; the description names them. */
  scopes?: string[];
  /** The tool's access class. Defaults to write. */
  class?: "read" | "write";
}

export function apiTool(vendor: string, scope: ApiToolScope = {}): IntegrationToolDecl {
  const args =
    "Args: method (GET/POST/PATCH/PUT/DELETE, default GET), path (starts with /), " +
    "query (object of strings), body (JSON object). Use the named tools for simple " +
    "lookups; use this for filters, associations, batch operations, and anything " +
    "else the API supports.";
  const reach =
    scope.scopes === undefined
      ? `Call any ${vendor} REST endpoint directly — the full API surface beyond the named tools. `
      : `Call a ${vendor} REST endpoint directly. This connection grants only ` +
        `${scope.scopes.join(", ")}: an endpoint outside that set answers 403. `;
  return {
    name: "api",
    class: scope.class ?? "write",
    description: `${reach}${args}`,
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
