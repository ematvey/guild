# API examples

HTTP examples for the org server. They assume the server runs on
`http://localhost:8080`. `$TOKEN` is a member session token from
`POST /api/v1/auth/login`.

## Application contracts

| App | HTTP base | Live session |
| --- | --- | --- |
| Work, including the desktop webview | `/api/v1/work` | `POST /api/v1/work/ws/ticket` and `GET /api/v1/work/ws` |
| Control Center | `/api/v1/control` | `POST /api/v1/control/ws/ticket` and `GET /api/v1/control/ws` |

Work serves chat, projects, machine use and pairing, approvals, member app use, skill installation, and personal routines. Control serves agent setup, integration and registry management, skill publishing, workspace policy, usage and activity. Identity and the catalog operations used by both clients have an address in each contract. Each route applies the permissions of the same signed-in member. A route outside a namespace is absent from that namespace.

A socket ticket is valid on its issuing contract. Work receives chat, project and machine state. Control receives management state and selected Activity views. Both receive the member, workspace, models, agents, Apps and skills relevant to their surfaces. The `WorkClientFrame`, `WorkServerFrame`, `ControlClientFrame`, and `ControlServerFrame` definitions in [the socket schema](../protocol/socket.schema.json) specify the frames each contract accepts and sends.

The unprefixed `/api/v1` endpoints remain the compatibility contract for installed desktop builds, the native engine, and existing external callers. The examples below use that contract. OpenAI- and Anthropic-compatible requests retain their gateway addresses.

## Headless client

The engine binary is also a CLI. It logs in and chats without the GUI:

```bash
cargo run -p guild-app-server -- login --url http://localhost:8080 \
  --email admin@example.org --password '<password>'
cargo run -p guild-app-server -- chat --model gpt-4o-mini "hello"
```

## Agent routines

A routine belongs to a persistent agent: a prompt on a schedule. `kind` is
`cron` (a five-field cron expression, or interval sugar such as
`every 30m`, minimum one minute, in `timezone`, default UTC) or `once`
(`run_at`). The scheduler in the server process claims each due occurrence
and starts an isolated agent run. There are no webhook triggers.

```bash
curl -X POST localhost:8080/api/v1/agents/$AGENT/routines \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"digest","kind":"cron","schedule":"0 9 * * 1-5","prompt":"Digest the inbox."}'
# run it now, and read its runs:
curl -X POST localhost:8080/api/v1/agents/$AGENT/routines/$ROUTINE/run -H "authorization: Bearer $TOKEN"
curl localhost:8080/api/v1/agents/$AGENT/routines/$ROUTINE/runs -H "authorization: Bearer $TOKEN"
```

`GET`/`PATCH`/`DELETE /api/v1/agents/:id/routines/:rid` read, change and
remove one routine (`apps/server/src/platform/http/agents.ts`).

## Public OpenAI-compatible endpoint

Admins issue an org API key (plaintext shown once):

```bash
curl -X POST localhost:8080/api/v1/admin/api-keys -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"ci"}'
```

Then any OpenAI client works against the org gateway:

```bash
curl -X POST localhost:8080/openai/v1/chat/completions \
  -H "authorization: Bearer gk_..." -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## SSO

Admins configure the org identity provider with
`PUT /api/v1/admin/oidc {issuer, client_id, client_secret}`. Browser login
starts at `GET /api/v1/auth/oidc/login?org_id=…` (302 to the IdP). The
callback provisions `identity_type=oidc` members on first login and issues a
normal session.

## Quotas

`PUT /api/v1/admin/gateway/routes` accepts `quota_monthly_usd`. The gateway
returns 429 `quota_exceeded` once month-to-date ClickHouse spend reaches the
cap.

## Attachments

`POST /api/v1/chats/{id}/attachments?filename=…` (raw body) uploads. List and
org-scoped download go through `/api/v1/attachments/{id}`. Bytes live in
object storage.

## Registry integration items

`POST /api/v1/registry/integration/{slug}/install` installs an MCP plugin
bundle (a `manifest.json` with an `mcp` block) as a disabled org integration.
An admin enables it and sets its secrets. A bundle that carries a
`routine.json` is refused.

## Org events

Events are written to the `events` table and fanned out over Postgres
LISTEN/NOTIFY to the member WebSocket as `org_event` frames.
`GET /api/v1/events` returns the latest 200. Emitted on registry
publish/update/unpublish/fork, skill install/uninstall/pin, and member join.

## Promote a queued message to steering

While an agent runs, queued message chips offer **Steer now**. This keeps the
message identity and delivers it at the next tool boundary. The session-auth
endpoint is `POST /api/v1/threads/:chatId/pending/:messageId/steer` (empty body,
or `{}` with JSON content type). It returns `{ "steering": true }`, or 409
when the message has already been placed or admission is still pending.

## Wire types

`protocol/*.schema.json` is the contract. The TypeScript types are
hand-written from it in `packages/wire`, the Rust types in
`crates/protocol/src`. Nothing generates either side.

## Desktop release approval

`POST /api/v1/admin/releases/github` (admin session) accepts
`{"tag":"client-v0.6.127"}`. The source is the public repository configured in
`GUILD_RELEASE_REPOSITORY`. All six signed artifact records, their GitHub digests
and sizes are checked before the server imports their metadata and approves the
version atomically. Success returns `{"version":"0.6.127","artifacts":6}`.
Preview tags require `GUILD_RELEASE_CHANNEL=develop`; the default is `stable`.
For deployment pairing, also send `source_commit` from `GET /api/v1/health`.
The tag version and source commit must match the running build, and
`release.json` must record the same commit.

`GET /api/v1/updates/latest.json` remains public and returns the approved complete
Tauri manifest. Imported artifacts use GitHub download URLs. The authenticated
release listing exposes GitHub artifact metadata. Download-URL responses contain
`url`; authenticated download requests redirect to GitHub.
The optional `channel=stable|develop` query selects the channel on the manifest,
listing and download endpoints; omission uses the server default. The manifest
includes `channel` and `server_version`. Approval, listing and every download
request reject versions newer than the running server. A stable server rejects
develop candidates; approvals are independent per channel.
