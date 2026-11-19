# API examples

HTTP examples for the org server. They assume the server runs on
`http://localhost:8080`. `$TOKEN` is a member session token from
`POST /api/v1/auth/login`.

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
