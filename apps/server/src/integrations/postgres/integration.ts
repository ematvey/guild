import { mcpIntegration } from "@guild/integration-sdk";

export default mcpIntegration({
  name: "postgres",
  title: "PostgreSQL",
  version: "1.0.0",
  publisher: "Guild",
  summary: "Explore PostgreSQL schemas and run read-only SQL with DBHub.",
  description: "Connect to a DBHub MCP server configured for read-only PostgreSQL access. Use search_objects to inspect schemas and execute_sql to retrieve data.",
  docs_url: "https://github.com/bytebase/dbhub",
  categories: ["data"],
  fields: [
    {
      name: "mcp_token",
      kind: "secret",
      label: "MCP bearer token",
      required: true,
      default: null,
      help: "Bearer token for the MCP endpoint.",
      placeholder: null,
    },
  ],
  mcp: {
    url: "https://postgres-mcp.example.com/mcp",
    headers: { Authorization: "Bearer {mcp_token}" },
    envelope: false,
  },
  tool_classes: {
    search_objects: "read",
    execute_sql: "write",
  },
});
