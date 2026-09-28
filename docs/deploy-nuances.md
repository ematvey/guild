# Guild — deploy nuances

Everything non-obvious about building, serving, and shipping Guild on this
host (`devbox`). Facts verified 2026-09-12 (host-services cutover). Companion
to `docs/clients.md` (client distribution details).

---

## 0. Host services (default operating mode, since 2026-09-12)

Guild prod AND tests use the shared **host-level** services — nobody runs
private copies by default. The neutral services live in `/data` and are owned
by no single project:

| Service | Compose dir | Endpoint | Creds |
|---|---|---|---|
| Postgres 17 | `/srv/postgres` | `127.0.0.1:5432` (published `0.0.0.0`) | admin `postgres` / `REDACTED_HOST_POSTGRES_PASSWORD`; Guild db/role: `guild`/`guild` |
| ClickHouse 26.5 | `/srv/clickhouse` | `0.0.0.0:8123` (HTTP) | `ch_user` / `ch_test_pass` |
| RustFS (S3) | systemd `rustfs.service`, data `/srv/rustfs` | `0.0.0.0:9950` S3 API, `:9951` console | `rustfsadmin` / `rustfsadmin` |
| Faro collector (Alloy+Loki) | `/srv/faro` | `0.0.0.0:12347` Faro receiver (`/collect`), Loki loopback `127.0.0.1:3100` | none (per-app rate limiting) |

Guild proxies browser telemetry through the server: `POST /faro/collect`
forwards to `GUILD_FARO_URL` (default the collector above; empty disables).
The client's Settings → About toggle (off by default) sends app diagnostics
to it. See `/srv/faro/README.md`.

- Each project gets its own **database/bucket** on the shared servers
  (Guild: db `guild`, bucket `guild`).
- Guild tests hit the same servers with per-run isolated DBs/buckets
  (`test_*` / `t*` names; stale `test_*` databases are reaped on first use).
  Override endpoints via `GUILD_TEST_PG_URL`, `GUILD_TEST_CLICKHOUSE_URL`,
  `GUILD_TEST_S3_URL` (+ `_USER`/`_PASSWORD`/`_ACCESS_KEY_ID`
  /`_SECRET_ACCESS_KEY`). There are **no testcontainers anymore**.
- `host.docker.internal` (compose `extra_hosts: host-gateway`) is how the
  Guild server container reaches these ports.
- History: `/srv/postgres.old-20260912` is a stale 15 GB orphan cluster
  (one 15 GB database, last served June 2026) — parked untouched, safe to
  delete after review. Guild's prod data was migrated into the new host
  postgres via pg_dump (2026-09-12); usage_events (71 rows) copied to host
  ClickHouse; MinIO objects (505 MB, 22 files) copied to rustfs.

---

## 1. What runs where

Two different "Guild" stacks exist on this host. **Don't confuse them.**

### The real one: compose stack on :18080

- Compose project: `~/guild/deploy/compose` (`docker-compose.yml` there).
- Running containers: `compose-server-1`, `compose-restate-1`. The infra
  services (postgres/clickhouse/minio) exist in the compose file behind the
  `fullstack` profile as a self-contained fallback and are **stopped**
  (`compose-postgres-1` etc.); the server reads config.env pointing at the
  host services (§0).
- `compose-server-1` publishes **0.0.0.0:18080 → 8080** (that's the chat app
  + API everything points at) and Restate admin is published on **9070**.
- Config: `deploy/compose/config.env` (gitignored — holds real secrets:
  `GUILD_MASTER_KEY_HEX`, `GUILD_JWT_SECRET`). `GUILD_HTTP_PORT=18080`
  because 8080 is already taken on this host. DB/CH/S3 URLs use
  `host.docker.internal:5432/8123/9950`.
- Server state lives in the named volume `guild_data` (`/data` inside the
  container). Restate journals live in `restate_data` mounted at
  `/restate-data`. The fullstack fallback volumes (`pgdata`, `chdata`,
  `miniodata`) still hold the pre-cutover data — keep until confident.
  `docker compose down -v` destroys all of it.
- Single-container mode: `GUILD_ROLE=all` (HTTP + worker roles in one
  binary; worker binds 9080 internally, Restate ingress is compose-internal,
  only the Restate admin port is published).

### The stale one: legacy Node stack on :9330

The Cloudflare tunnel ingress for `guild.example.com` targets `localhost:18080`
(`/etc/cloudflared/config.yml`); it previously targeted :9330 and produced 502s
once the legacy stack stopped.

- Containers `guild-web-1` (Next-ish web on :3000), `guild-api-1`
  (`npm run start -w @guild/api` on :4000), `guild-nginx-1` (:9330),
  `guild-db-1`, `guild-cli-releases-1` — running since 2026-09-02.
- **The compose file that defined them (`~/guild/docker-compose.yml`) has
  been deleted from the repo**; the `@guild/api`/`guild-web` workspaces no
  longer exist. This is a leftover of an earlier architecture.
- Teardown candidate (`docker rm -f` the five containers + `docker rmi
  guild-web guild-api guild-nginx guild-cli-releases guild-migrate`) — but
  confirm nothing still points at :9330 first.
- Recognition shortcut: `guild-*-1` names = legacy; `compose-*-1` names =
  current.

---

## 2. The big gotcha: frontends are embedded in the server binary

`crates/server/src/http/web.rs`:

```rust
static CHAT_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../apps/desktop/dist");
static WEB_DIST: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../apps/webui/dist");
```

Consequences:

- **A local `vite build` (or any edit under `apps/*/`) does NOT change what
  `http://localhost:18080` serves.** The running container serves whatever
  was compiled into its binary at Docker image build time. Editing files,
  rebuilding the frontend locally, even restarting the container — none of
  it ships frontend changes.
- `build.rs` only `create_dir_all`s the dist dirs and prints
  `cargo:rerun-if-changed` — it does not build the frontends. The Dockerfile
  builds them.
- The server returns a 503 hint ("run `npm --prefix apps/webui run build`")
  if a dist dir is empty at compile time.

### Shipping a frontend change (the canonical recipe)

```bash
cd ~/guild/deploy/compose
docker compose build server && docker compose up -d server
```

- The Dockerfile compiles both frontends inside (stages `webui` and
  `chatapp`), copies the dists into the Rust build stage, and `cargo build
  --release -p guild-server` embeds them.
- Changing anything under `apps/desktop/` invalidates the `chatapp` stage
  (fresh `npm ci` + `npm run build`) **and** the `COPY --from=chatapp`
  layer, which invalidates the cargo layer → **full Rust release rebuild
  inside Docker** (the `target/` dir is not cached across builds). Expect
  the long pole to be cargo, not npm.
- Backend-only changes (`crates/`) also invalidate the cargo layer the same
  way — same recipe, same cost.
- For long builds run it detached (see §7).

### Verify the new bundle actually went live

```bash
curl -s localhost:18080/thread/x | grep -oE 'index-[A-Za-z0-9_-]+\.js'
curl -s localhost:18080/api/v1/health          # {"status":"ok"}
```

A changed asset hash = new bundle. Optionally
`docker run --rm --entrypoint sh compose-server -c "grep -ac 'SomeNewString'
/usr/local/bin/guild-server"` to confirm a specific change is embedded.

---

## 3. Dockerfile stage map (`~/guild/Dockerfile`)

| Stage | Base | Does |
|---|---|---|
| `webui` | node:22 | `npm ci --workspace apps/webui` + build (admin console) |
| `chatapp` | node:22 | `npm ci --workspace apps/desktop` + build (chat UI) |
| `build` | rust:1.97 | copies `crates`, `apps/desktop/src-tauri`, both dists; `cargo build --release -p guild-server` |
| runtime | debian:trixie-slim | just the `guild-server` binary + ca-certificates; `ENTRYPOINT ["guild-server"]` |

Notes:

- npm deps are hoisted via root workspaces; each stage copies
  `package.json`/`package-lock.json` + `packages/ui` + its app only —
  **adding a dependency to one app requires the lockfile update to flow
  through** (lockfile is COPYed in every frontend stage).
- Build context is the repo root (`context: ../..`), so anything new the
  build needs must be COPYed explicitly; there is no `.dockerignore`-visible
  sneaking in.

---

## 4. Compose stack details

- Default `up` starts only `server` + `restate`; postgres/clickhouse/minio
  are behind the `fullstack` profile (`--profile fullstack` to use them).
- Server startup order: server waits only for restate `started` (host
  services are already up). If the server crash-loops on boot, check the
  host services first (`/srv/postgres`, `/srv/clickhouse`,
  `rustfs.service`).
- The fullstack fallback ClickHouse stays pinned to
  `clickhouse-server:24`; the host ClickHouse floats 26.5
  (`pull_policy: always`) — a host CH upgrade can change behavior.
- Registry bundles live in rustfs bucket `guild` (host :9950).
- Restate is pinned to the deployed image digest. Upgrade its image and
  stored journal format deliberately, with a stopped-data backup.
- Restate's node name is persistent identity, not a disposable container
  hostname. Compose supplies `RESTATE_NODE_NAME` from
  `GUILD_RESTATE_NODE_NAME` (`guild-restate` for a fresh installation).
  On migration, set that variable in compose's ignored `.env` to the
  **existing data's node name** before recreating the container. This host
  retains `4ff015b84014`; changing it makes Restate refuse the existing data.
- When adopting `restate_data` on an older installation with no mount,
  **do not run compose up against an empty volume**. Stop server and
  Restate, copy the stopped container's `/restate-data/.` to a private
  backup, seed the named volume with those exact bytes, and only then
  recreate Restate. Compare file hashes before starting and retain the
  backup. Recheck outstanding invocations before workflow-code changes;
  adding journal operations can make old in-flight invocations incompatible.
  Wait for Restate's admin query endpoint as well as server health after
  startup; server health alone does not establish workflow readiness.
- Host port overrides: `GUILD_HTTP_PORT` (18080 here), `GUILD_RESTATE_ADMIN_PORT`
  (9070) in `config.env`.
- Server-side agent sessions store under `GUILD_DATA_DIR=/data`;
  `GUILD_ALLOW_SHELL_TOOLS=1` (commented out) is the opt-in for
  `run_command` in server sessions.

---

## 5. First-run / admin plumbing

- Bootstrap (once, until an admin exists):
  `POST /api/v1/auth/bootstrap` with `{"email","password"}`.
- Provider keys & model routes are configured via the admin API (see
  `deploy/README.md` for copy-paste examples) or the admin console at
  `http://localhost:18080/admin/` (served by the same binary, WEB_DIST).
- Desktop pairing: generate a code in the web app (Settings → Connect
  desktop app); the desktop client pairs against the same :18080.

---

## 6. PWA / service worker (rarely the culprit)

`apps/desktop/public/sw.js`, cache name `guild-shell-v1`:

- **Network-first** for all same-origin GETs (except `/api/` — always
  passthrough): fresh response when online, cache only as offline fallback,
  successful responses refresh the cache.
- So a stale UI after deploy is almost never the SW — it's the
  embed-at-build-time binary (§2). A plain reload picks up new index.html
  fine.
- Known console noise: `/favicon.ico` and `/icon-192.png` return 503 from
  the server on some loads — cosmetic bug in the server's static/asset
  handling, not a deploy problem (as of 2026-09-10).

---

## 7. Running long rebuilds detached

`docker compose build server` can run long (cargo release). Use the
`big-job` skill (systemd-run transient unit, journal output). Two traps:

- **No shell operators after `systemd-run --`** — `a && b` becomes literal
  args. Wrap: `-- bash -lc 'cd .../deploy/compose && docker compose build
  server && docker compose up -d server'`.
- Always pass an explicit working directory (systemd-run inherits the
  caller's cwd otherwise).

---

## 8. Desktop clients (summary; full detail in `docs/clients.md`)

- One binary (`guild-desktop` crate), three modes: GUI / `engine` (self-
  spawned JSON-RPC over stdio) / headless CLI verbs (`login`, `chat`,
  `publish`, `install`, `verify`).
- Auto-updater: Tauri updater, minisign keypair `~/.tauri/guild.key`
  (passwordless), pubkey baked into `apps/desktop/src-tauri/tauri.conf.json`;
  endpoint `http://localhost:18080/api/v1/updates/latest.json` with
  `dangerousInsecureTransportProtocol: true` (plain HTTP is intentional for
  this deployment). `createUpdaterArtifacts: true`.
- Two publisher scripts, both **idempotent** (they delete+republish an
  existing version/platform artifact) and both verify the server's sha256
  against the local file:
  - `scripts/release-clients.sh` — production-format artifacts:
    Windows NSIS installer (cargo-xwin cross-build), Linux AppImage
    (linuxdeploy), macOS DMGs (unsigned). Updater-signed. Heavy build-host
    deps: zig + cargo-zigbuild, macOS SDK at `$SDKROOT`, mingw-w64, makensis,
    llvm, `~/opt/linuxdeploy`, `~/opt/libdmg-hfsplus`, hfsprogs, 7z.
  - `scripts/release-desktop.sh` — portable tar.gz/zip builds for
    linux/mac/windows (zigbuild), not installer-format.
  - Usage: `BASE=http://localhost:18080 TOKEN=<admin-token> VERSION=x.y.z
    scripts/release-clients.sh`.
  - Running the release script from a systemd transient unit needs an explicit
    `-E PATH=...` including `~/.cargo/bin` (cargo-xwin/zigbuild) — the unit's
    default PATH lacks it and the build fails with "cargo-xwin command not
    found" (hit 2026-09-11). Also pass `-E TAURI_SIGNING_PRIVATE_KEY=` for the
    bundler to sign updater artifacts.
- Artifacts land in `/api/v1/releases` (MinIO-backed); the desktop
  updater consumes `latest.json`.
- Local desktop dev: `npm run dev` (vite, port 1420 strict) +
  `npm run tauri dev`; `devUrl` in `tauri.conf.json` points at :1420. The
  GUI spawns `guild-desktop engine` — same binary, so rebuild the Rust
  binary for engine changes too.

---

## 9. Quick recipes

```bash
# ship a frontend or backend change to :18080
cd ~/guild/deploy/compose && docker compose build server && docker compose up -d server

# just restart (e.g. after config.env change)
docker compose up -d server   # recreate if env changed: --force-recreate

# what's actually being served?
curl -s localhost:18080/thread/x | grep -oE 'index-[A-Za-z0-9_-]+\.(js|css)'

# nuke everything including data (destructive!)
docker compose down -v
```

# Daemon watch-items (milestone-8, 2026-09-10)

Maintenance notes for the per-user daemon (`docs/plans/2026-09-10-milestone-8-daemon.md`).
Check these when touching releases, tests, or the daemon itself.

1. **Bump the workspace version on every release.** The attach handshake
   (`daemon.hello` → version compare) reads `CARGO_PKG_VERSION` of the
   shared `guild-app-server` lib on both sides, so it only distinguishes
   builds if the workspace `[workspace.package] version` actually moves.
   A stale version makes every daemon look current — a mismatched old
   daemon would never be told to shut down and respawn.

2. **The `#[ignore]`d app-server tests** (`agent_rpc` × 2, `roundtrip` × 2,
   skipped for missing embedded Restate in the test env). If they are ever
   un-ignored, note they exercise `serve()` (stdio surface), where
   post-EOF agent events are delivered via `run_connection`'s drain tail +
   `serve()`'s subscribe-before-drain safety net — that delivery contract
   is load-bearing for them.

3. **Daemon shutdown is unconditional** (`process::exit(0)` after
   `run_daemon()` in both binaries). Clients holding a socket mid-request
   get dropped connections at shutdown — deliberate: waiting for them
   deadlocks tokio runtime teardown (blocking tasks ↔ client EOF).
   Don't "fix" the exit into a graceful drain without solving that.

4. **Test-hygiene pattern for anything touching the daemon:** every test
   must use a distinct socket path (they collide on PID-derived names when
   run in parallel), clients should set a read timeout (5s) so a
   regression fails fast instead of hanging the suite, and a fake server
   on a socketpair must hold its end open until the client closes (early
   close = EPIPE/EOF races; also: writes to one end arrive at the OTHER
   end — crossed ends make the client read back its own requests).

5. **Overrides for dev:** `GUILD_DAEMON_BIN` (which binary to spawn as
   daemon), `GUILD_DAEMON_SOCKET` (socket/pipe path). Release builds use
   `cargo xwin check` (msvc) and `cargo zigbuild --lib` (apple) as
   compile gates; full binary links happen in the release pipeline
   (Windows SDK / macOS SDK needed there).
