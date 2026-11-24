# PostgreSQL

Use [Bytebase DBHub](https://github.com/bytebase/dbhub) to inspect PostgreSQL schemas and run read-only SQL.

1. Run DBHub with `--transport http` on a host with access to PostgreSQL. Configure its PostgreSQL source using a dedicated read-only role. In the [DBHub configuration](https://github.com/bytebase/dbhub/blob/main/dbhub.toml.example), set `readonly = true` for `execute_sql` and keep the configuration containing the DSN private.
2. Put the DBHub `/mcp` endpoint behind a reverse proxy that validates a bearer token. Limit direct access to DBHub to the proxy.
3. In Guild, add PostgreSQL from the Integrations shop. Enter the proxy's Streamable HTTP MCP URL and bearer token, then enable the integration.
4. In Tools, enable `search_objects` and `execute_sql` as needed. Give the agent access to the integration.

DBHub holds the PostgreSQL credentials. Guild stores the MCP bearer token.
