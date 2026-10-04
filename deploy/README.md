# Deploy — Guild server

Full server-side stack: guild-server, Postgres, ClickHouse, MinIO, Restate.

## Run

```bash
cd deploy/compose
cp config.env.example config.env
# set a real master key: openssl rand -hex 32
# set a real jwt secret:  openssl rand -hex 32
docker compose up -d --build
```

Health check: `curl -s localhost:8080/api/v1/health` → `{"status":"ok"}`.
Restate admin UI: `http://localhost:9070`.

## First-run bootstrap

```bash
curl -s -X POST localhost:8080/api/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.org","password":"<password>"}'
```

Then log in (`POST /api/v1/auth/login`) and configure provider keys and
model routes with the admin API:

```bash
TOKEN=...  # from login
curl -s -X POST localhost:8080/api/v1/admin/gateway/keys \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"openai","base_url":"https://api.openai.com","key":"sk-..."}'

curl -s -X PUT localhost:8080/api/v1/admin/gateway/routes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","provider":"openai","enabled":true,"price_in":0.15,"price_out":0.6}'
```

## Registry smoke test

```bash
mkdir -p /tmp/demo-skill/deploy-check
printf -- '---\nname: deploy-check\ndescription: verify deploys\n---\nSteps.' > /tmp/demo-skill/deploy-check/SKILL.md

cargo run -p guild-app-server -- publish --kind skill   --dir /tmp/demo-skill/deploy-check --version 1.0.0
# approve in the web UI/admin API, then:
cargo run -p guild-app-server -- install --slug deploy-check --project /tmp/demo-project
```

(Routines — scheduled/webhook-triggered runs — are deferred, spec decision 8:
their routes answer 404.)

## Headless client smoke test

```bash
cargo run -p guild-app-server -- login --url http://localhost:8080 \
  --email admin@example.org --password '<password>'
cargo run -p guild-app-server -- chat --model gpt-4o-mini "hello"
```

## Ports

`GUILD_HTTP_PORT` (default 8080) overrides the published host port if it is
taken.

## Teardown

```bash
docker compose down -v
```
