# Deploy — Guild server

Server-side installation: the TS server (`apps/server`, Dockerfile.server-ts)
on Kubernetes, with host Postgres, ClickHouse and S3-compatible storage.

The chart and the install procedure live in
[`kubernetes/README.md`](kubernetes/README.md). This page is the short
version: image, rollout, bootstrap, client publication.

## Build and roll

```bash
docker build -f Dockerfile.server-ts \
  --build-arg GUILD_BUILD_VERSION=<version> \
  -t guild-server-ts:<commit> .
docker save guild-server-ts:<commit> | sudo k3s ctr images import -
kubectl -n guild-dev set image deploy/guild server=guild-server-ts:<commit>
kubectl -n guild-dev rollout status deploy/guild --timeout=10m
```

Health check: `curl -s -H 'Host: <public host>' http://127.0.0.1:30080/api/v1/health`
→ `{"status":"ok","version":"..."}`. The image serves the web frontend; a
local `vite build` never reaches it (`docs/deploy-nuances.md` §2).

## Publish desktop clients

The server build does not build or publish desktop installers. After a new
deployment, run the client release separately for the version in
`apps/desktop/src-tauri/tauri.conf.json`. Set the public server URL so a
fresh install opens with this deployment selected:

```bash
BASE=https://guild.example.com \
TOKEN=<admin-session-token> \
VERSION=<desktop-version> \
VITE_DEFAULT_SERVER_URL=https://guild.example.com \
  scripts/release-clients.sh
```

This builds and uploads Windows, Linux, and macOS installers and updater
artifacts. Check the authenticated `/api/v1/releases` list for six artifacts
and `/api/v1/updates/latest.json` for the new version and all four platforms.
See `docs/clients.md` for toolchain requirements and signing details.

## First-run bootstrap

```bash
curl -s -X POST https://guild.example.com/api/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.org","password":"<password>"}'
```

Then log in (`POST /api/v1/auth/login`) and configure provider keys and
model routes with the admin API:

```bash
TOKEN=...  # from login
curl -s -X POST https://guild.example.com/api/v1/admin/gateway/keys \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"openai","base_url":"https://api.openai.com","key":"sk-..."}'

curl -s -X PUT https://guild.example.com/api/v1/admin/gateway/routes \
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

Routines — runs on a schedule — are documented in `docs/api.md`.

## Headless client smoke test

```bash
cargo run -p guild-app-server -- login --url https://guild.example.com \
  --email admin@example.org --password '<password>'
cargo run -p guild-app-server -- chat --model gpt-4o-mini "hello"
```

## Teardown

```bash
helm -n guild-dev uninstall guild
```
