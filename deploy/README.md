# Deploy — Guild server

Server-side installation: the TS server (`apps/server`, Dockerfile.server-ts)
on Kubernetes, with host Postgres, ClickHouse and S3-compatible storage.

The chart and the install procedure live in
[`kubernetes/README.md`](kubernetes/README.md). This page is the short
version: image, rollout, bootstrap, client publication.

## Build and roll

Follow the [server build and Helm rollout procedure](../docs/deploy-nuances.md#1-build-and-deploy-the-server).
The server image includes the web frontend.

## Publish desktop clients

Use the [deployment release pairing procedure](../docs/clients.md#pairing-a-deployment-with-a-desktop-release)
to publish the exact matching desktop release on the installation.

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
helm uninstall guild --kube-context "$context" --namespace "$namespace"
```
