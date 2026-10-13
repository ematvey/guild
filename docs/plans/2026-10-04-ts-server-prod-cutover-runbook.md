# Prod cutover runbook — TS server on pi-durable (:18081, ~/guild-prod)

Date: 2026-10-04. Status: **waiting on maintainer's dev validation** — the
milestone plan gates the prod ladder on "repeat M7 there after dev
stabilizes". Everything below is prepared so the green-lights execution is
mechanical. Dev ladder status: complete (see PLAN.md top entries; branch
`agent-plane`, worktree `~/guild-wt-agent-plane`).

## Preconditions (maintainer)

1. Dev validation done: real desktop usage on :18080 (chats, tool dispatch
   on machine-bound chats) without regressions.
2. Green light for prod.

## Current prod facts (verified 2026-10-04)

- `~/guild-prod`, branch master @ 2211877 (== develop). Local UNCOMMITTED
  edits: `.gitignore`, `deploy/README.md`, `deploy/compose/docker-compose.yml`
  (the `GUILD_SERVER_IMAGE` overridable-tag pattern), `docs/clients.md`,
  `docs/deploy-nuances.md`. Never rebase this checkout.
- compose project `guild-prod`, :18081, image `guild-server:prod`.
- DB `guild_prod` (user `guild_prod`): 1 chat / 3 thread_events / 3 users /
  1 machine; model route `GLM-5.3-Flash` present. Live users exist — the
  cutover briefly disconnects them (daemons auto-reconnect).
- `config.env`: has `GUILD_ROLE=all` + `GUILD_INTERNAL_TOKEN` (both inert
  after the ladder; leave or remove), `GUILD_API_URL=https://guild.example.org`.

## Steps

1. **Land on develop** (in `~/guild`): `git merge --ff-only agent-plane`
   (develop == the branch point, so this is a fast-forward). Run the suite
   once from `~/guild`: `npm test --workspace apps/server`.
2. **Prod checkout**: `cd ~/guild-prod && git stash push -m prod-local-edits`
   → `git merge --ff-only develop` → re-apply the local edits:
   - compose: the TS image line now reads
     `${GUILD_TS_SERVER_IMAGE:-guild-server-ts:latest}` — set in
     `deploy/compose/.env`: `GUILD_TS_SERVER_IMAGE=guild-server-ts:prod`.
   - The Rust `server-rust` service no longer exists upstream (retired) —
     drop the `GUILD_SERVER_IMAGE` line from `.env` (its service is gone).
   - Re-apply `.gitignore`/docs stash entries (`git stash pop`; resolve
     trivially — compose now carries the override pattern upstream).
3. **Prod env**: in `deploy/compose/config.env` add
   `GUILD_INTERNAL_KEY=<openssl rand -hex 32>` (never public; the harness's
   loopback credential). `GUILD_ROLE`/`GUILD_INTERNAL_TOKEN`/`GUILD_RESTATE_*`
   can be deleted (inert). Keep `GUILD_API_URL` as-is.
4. **Backup**: `docker exec postgres-postgres-1 pg_dump -U guild_prod
   guild_prod > ~/backups/guild_prod-$(date +%F-%H%M).sql`.
5. **Build + import** (downtime starts): `cd ~/guild-prod/deploy/compose &&
   docker compose build server` (TS image incl. the webui stage) →
   `docker compose stop server` → importer final run on the prod DB:
   `set -a && source config.env && set +a && cd ~/guild-prod/apps/server &&
   GUILD_DATABASE_URL=$GUILD_DATABASE_URL GUILD_S3_URL=$GUILD_S3_URL
   GUILD_CLICKHOUSE_URL=$GUILD_CLICKHOUSE_URL npm run import-threads`
   (prod data is tiny: expect `1 chats → 1 conversations`). Verify the
   printed counts match the pre-run `SELECT count(*)` snapshot.
6. **Up**: `docker compose up -d` (restate is gone from the compose file;
   remove its leftover container/volume if compose didn't:
   `docker rm -f guild-prod-restate-1 && docker volume rm
   guild-prod_restate_data`).
7. **Verify**: `curl -s https://guild.example.org/api/v1/health`
   (status ok, version 0.1.x); SPA `/` serves; the prod machine reconnects
   (`docker compose logs server | grep 'machine connect'`); headless login
   + one turn against :18081 (or hand to maintainer for the first real chat);
   usage lands in ClickHouse (`usage_events` has new rows after a turn).
8. **Observe**: watch `docker compose logs -f server` for ~30 min; zero
   level-50 lines expected (dev baseline).

## Rollback

- `cd ~/guild-prod && git stash` (any adapted files) →
  `git reset --hard 2211877` → `git stash pop` → `docker compose build
  server && docker compose up -d` (the Rust image `guild-server:prod` still
  exists; restate service is in the old compose file — it comes back up).
- Data: the importer only truncates/rebuilds `durable_*` +
  `chat_conversations`; `chats`/`thread_events` are untouched. Full restore
  from the step-4 dump if ever needed.

## Post-cutover

- PLAN.md decision entry (prod ladder complete; note the restate
  container/volume removal).
- `~/guild-prod` stays on its local-edit pattern; do not rebase.
