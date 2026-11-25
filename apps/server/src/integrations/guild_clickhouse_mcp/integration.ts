import { mcpIntegration } from "@guild/integration-sdk";

export default mcpIntegration({
  name: "guild_clickhouse_mcp",
  title: "ClickHouse",
  version: "1.0.0",
  publisher: "Guild",
  summary: "Explore ClickHouse schemas and run read-only analytics queries.",
  description: "Connect to the official ClickHouse MCP server. Use list_databases and list_tables to discover schemas, then run_query to retrieve data.",
  docs_url: "https://github.com/ClickHouse/mcp-clickhouse",
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
    url: "https://clickhouse-mcp.example.com/mcp",
    headers: { Authorization: "Bearer {mcp_token}" },
    envelope: false,
  },
  tool_classes: {
    list_databases: "read",
    list_tables: "read",
    run_query: "write",
  },
});
