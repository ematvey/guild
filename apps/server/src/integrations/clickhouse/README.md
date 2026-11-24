# ClickHouse

Use the [ClickHouse MCP server](https://github.com/ClickHouse/mcp-clickhouse) to list databases and tables and run read-only analytics queries.

1. Run the MCP server on a host with access to ClickHouse. Set its database connection environment variables using a dedicated read-only ClickHouse user. Use the cluster's HTTP interface and match its TLS settings. Keep `CLICKHOUSE_ALLOW_WRITE_ACCESS` disabled.
2. Set `CLICKHOUSE_MCP_SERVER_TRANSPORT=http` and `CLICKHOUSE_MCP_AUTH_TOKEN` on the MCP server. If you configure allowed hosts, include the host and port Guild uses.
3. In Guild, add ClickHouse from the Integrations shop. Enter the MCP server's Streamable HTTP URL ending in `/mcp` and its bearer token, then enable the integration.
4. In Tools, enable the database, table and query tools the agent needs. Give the agent access to the integration.

The MCP server holds the ClickHouse credentials. Guild stores the MCP bearer token.
