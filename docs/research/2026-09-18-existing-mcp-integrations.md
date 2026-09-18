# Existing third-party integrations in a unified format

Date: 2026-09-18. Research note; no code changed.

## Bottom line

The unified format already exists and Guild already speaks it: the plugin
contract (docs/specs/2026-09-12-integration-plugins-design.md) is a
streamable-HTTP MCP server behind a registry bundle manifest. The industry
unified format is MCP, and the **official MCP Registry**
(registry.modelcontextprotocol.io) is the catalog of servers in exactly that
shape — each entry carries `remotes: [{type: "streamable-http", url}]` and
structured auth metadata. Guild can adopt these as `kind: "integration"`
bundles with zero new protocol work; the only real gap is auth-header
mapping (below).

## Ready-to-adopt servers (verified against primary sources)

| Vendor | Remote endpoint | Auth | Fits Guild auth kind |
|---|---|---|---|
| GitHub (official) | `https://api.githubcopilot.com/mcp/` (+ toolset/`readonly` URL variants) | PAT via `Authorization: Bearer` **or** OAuth | `org_secret` — works today |
| GitLab (official) | `https://gitlab.com/api/v4/mcp` | PAT (GitLab 18.x beta) | `org_secret` — works today |
| Atlassian (official, Jira/Confluence/Compass) | `https://mcp.atlassian.com/v1/mcp` | OAuth 2.1 per user | needs OAuth flow (M9 out-of-scope item) |
| Notion (official) | `https://mcp.notion.com/mcp` | OAuth | needs OAuth flow |
| Linear (official) | `https://mcp.linear.app/mcp` | OAuth per user | needs OAuth flow |
| Slack (official, beta) | `https://api.slack.com/mcp` (endpoint live; 401 without auth) | OAuth per user | needs OAuth flow |
| HubSpot (official) | `https://mcp.hubspot.com` (endpoint live; 401 without auth) | OAuth | needs OAuth flow |
| Zapier (aggregator, ~8k apps) | `https://mcp.zapier.com/api/v1/connect` | API key / connection URL | `org_secret` — works today |
| Composio (aggregator, 100s of SaaS) | `https://connect.composio.dev/mcp` | API key | `org_secret` — works today |
| Google Cloud APIs (official, per-API: compute, bigquery, bigtable…) | `https://<api>.googleapis.com/mcp` | OAuth | needs OAuth flow |

Verified community/self-hostable extras from the same registry: ClickHouse
official (`io.github.ClickHouse/mcp-clickhouse`, stdio — runnable via the
Docker gateway below), plus hundreds of streamable-HTTP servers on Smithery
(`server.smithery.ai/...`, `Authorization: Bearer {api_key}` — org_secret).

## The two adoption gaps

1. **Secret header mapping.** Guild sends resolved secrets only as
   `x-guild-secret-<name>` headers (crates/server/src/integrations.rs:467,
   mcp_pool.rs). Third-party servers expect standard headers
   (`Authorization: Bearer …`, `X-API-Key`). The registry schema already
   models the fix: per-remote `headers: [{name, value: "Bearer {api_key}",
   isSecret}]` templates. Add the same small field to the v2 manifest /
   integration config — then every PAT/API-key server above is installable
   with no other change.
2. **OAuth per-user servers.** The official Atlassian/Notion/Linear/Slack/
   HubSpot servers are OAuth 2.1 per-user. Guild v1 stores per-user tokens
   (`per_user_token`) but has no consent flow (explicitly out of scope in
   M9). Until then these stay behind the org-secret gate — or via
   aggregators (Zapier/Composio) that flatten many vendors into one
   API-key-authenticated endpoint.

## Easiest breadth: Docker MCP Catalog + Gateway

Docker's MCP Catalog (~300 signed server images, hub.docker.com/mcp) plus
the MCP Gateway (docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/)
runs catalog servers — including stdio ones — behind **one streamable-HTTP
endpoint** with its own secrets handling. Self-hosting the gateway on this
box would convert the whole stdio ecosystem (including the official
ClickHouse, filesystem, and Postgres servers) into Guild's contract, and
keeps vendor CLIs server-side exactly as the design intends.

## Adoption path

- No spec change needed: publish each server above as a registry bundle
  (`kind: "integration"`, `mcp.url`, `settings.fields` with a `secret` for
  the PAT/key, `tools.classes` matching the server's read/write split).
- One code feature unlocks the PAT/key tier: manifest-level auth-header
  templates (registry-schema-compatible).
- OAuth tier waits on the M9 OAuth follow-up, or goes through
  Zapier/Composio with an org API key.

## Who the connection belongs to (follow-up, 2026-09-18)

The MCP spec has no org or role concept. For HTTP transports, authorization
is OAuth 2.1 **per connection**: the server is a resource server, the client
acts on behalf of a resource owner, and the tool calls run with that token's
permissions (modelcontextprotocol.io spec 2025-06-18, Authorization). Stdio
servers just take credentials from the environment. So per-user vs per-org
is a property of each server's auth design, not of MCP:

- **Per-user OAuth** (HubSpot, Atlassian, Slack, Linear, Notion official
  servers): every human connects their own account. Scope comes from the
  OAuth grant; fine-grained "who may call which tool" is not in the
  protocol — it is the host's job (Guild: tool classes + org policy).
- **API key / PAT** (GitHub PAT, GitLab PAT, Zapier, Composio, Smithery):
  the token belongs to whatever account created it — org-wide if it is a
  service/bot account, personal if a human's token. One connection, no
  per-user identity unless the server reads it from headers (Guild's
  envelope pattern is ours, not a standard).

### HubSpot specifically (developers.hubspot.com/mcp)

The official remote server is OAuth 2.0 (moving to 2.1 with PKCE +
refresh-token rotation), per-user, via a **HubSpot user-level app**: the
HubSpot account admin connects first, then that account's users can
connect; the app's scopes bound what data any agent gets. For client orgs
to connect their own accounts, Guild would act as the MCP client and needs
the M9 out-of-scope piece generalized: per-org OAuth client config (the
client's own HubSpot app credentials as secrets) + a consent flow +
refresh handling, caching tokens per (org, integration, member) — the
`per_user_token` row shape already exists (`user:<guild user id>`).

Working-today alternatives for a client's HubSpot, no OAuth flow needed:

1. The existing built-in `hubspot` connector with a **private-app token**
   per client org (`org_secret`) — org-wide connection, acting identity is
   the app, not individuals.
2. A self-hosted/community HubSpot MCP server that accepts a private-app
   token, exposed as one streamable-HTTP endpoint (same org_secret shape).
3. An aggregator (Composio/Zapier): clients connect accounts in the
   aggregator's dashboard; Guild holds one org API key. Trade-off: the
   aggregator sees all traffic.

### Token scoping per server (verified by probing live endpoints, 2026-09-18)

The official gitlab.com MCP (`gitlab.com/api/v4/mcp`) is an MCP-spec OAuth
2.1 resource server: unauthenticated `initialize` returns 401 with
`WWW-Authenticate: Bearer realm="GitLab" scope="mcp"` and
`/.well-known/oauth-protected-resource/api/v4/mcp` lists `gitlab.com` as
the authorization server. PAT acceptance is unverified (docs.gitlab.com is
bot-walled). Where an official MCP is OAuth-only, the org-token pattern
still exists at the vendor's own token layer: GitLab group access tokens
(`gldt-`, bot users owned by a group), GitHub machine users / GitHub App
installations, Notion internal-integration tokens (`secret_…`) — accepted
by token-auth community MCP servers (e.g. `io.github.awkoy/notion-mcp`)
and by our built-in connectors (gitlab.rs already runs org-wide against
gitlab.acme.dev with a stored token). Atlassian and HubSpot official
servers have no token tier at all: OAuth per user only.

Note: the hosted gitlab.com MCP serves gitlab.com only — the guild GitLab
(self-hosted gitlab.acme.dev) can never use it; the org-scoped path
there is the built-in connector, as configured today.

## Sources

- github/github-mcp-server `docs/remote-server.md` (endpoint, toolsets, PAT/OAuth)
- Official MCP Registry API: registry.modelcontextprotocol.io/v0/servers
  (entries for com.atlassian, com.gitlab, com.notion, app.linear, com.zapier,
  ComposioHQ, com.googleapis.*, ai.smithery/*; header-auth metadata shape)
- Docker MCP Catalog & Gateway docs (docs.docker.com/ai/mcp-catalog-and-toolkit/)
- api.slack.com/mcp and mcp.hubspot.com — endpoints live, auth-gated (401)
- Guild contract: docs/specs/2026-09-12-integration-plugins-design.md,
  docs/specs/2026-09-16-integration-adapters-design.md
