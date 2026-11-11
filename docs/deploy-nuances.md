# Guild — deploy nuances

Everything non-obvious about building, serving, and shipping Guild on a
single Docker host. Companion to `docs/clients.md` (client distribution
details).

---

## 0. Host services (default operating mode)

Guild prod AND tests use shared **host-level** services — nobody runs
private copies by default. Each service belongs to the host, not to this
project:

| Service | Endpoint | Notes |
|---|---|---|
| Postgres 17 | `127.0.0.1:5432` | Guild database and role: `guild` |
| ClickHouse | `0.0.0.0:8123` (HTTP) | Guild database: `guild` |
| S3-compatible storage | `0.0.0.0:9950` (S3 API), `:9951` (console) | Guild bucket: `guild` |
| Faro collector (Alloy + Loki) | `0.0.0.0:12347` (`/collect`) | No auth; per-app rate limiting |

Service data directories, admin credentials, and the S3 root pair live
outside this repo, in the host's service configuration.

Guild proxies browser telemetry through the server: `POST /faro/collect`
forwards to `GUILD_FARO_URL` (default the collector above; empty disables).
The switch is the workspace's: `telemetry_enabled` in `org_kv`, **on when
absent**, admin-only (`Settings → General`, `PUT /api/v1/org/telemetry`).
The value rides the `workspace_identity` frame, so every client starts or
stops collecting live. There is no per-device toggle; About shows the state
read-only.

- Each project gets its own **database/bucket** on the shared servers
  (Guild: db `guild`, bucket `guild`).
- Guild tests hit the same servers with per-run isolated DBs/buckets
  (`test_*` / `t*` names; stale `test_*` databases are reaped on first use).
  Override endpoints via `GUILD_TEST_PG_URL`, `GUILD_TEST_CLICKHOUSE_URL`,
  `GUILD_TEST_S3_URL` (+ `_USER`/`_PASSWORD`/`_ACCESS_KEY_ID`
  /`_SECRET_ACCESS_KEY`). There are **no testcontainers anymore**.
- `host.docker.internal` (compose `extra_hosts: host-gateway`) is how the
  Guild server container reaches these ports.
- An older Postgres cluster may still exist on the host after a migration.
  It is not used by Guild; remove it only after a manual review.

---

## 1. What runs where

Guild can run on two stacks on one host: a dev stack and a prod stack.
**Don't confuse them.**

### Dev: compose stack on :18080

- Compose project: `deploy/compose` (`docker-compose.yml` there).
- Running container: `compose-server-1` (the TS server). The infra services
  (postgres/clickhouse/minio) exist in the compose file behind the
  `fullstack` profile as a self-contained fallback and are **stopped**
  (`compose-postgres-1` etc.); the server reads config.env pointing at the
  host services (§0).
- `compose-server-1` publishes **0.0.0.0:18080 → 8080** (that's the chat app
  + API everything points at).
- Config: `deploy/compose/config.env` (gitignored — holds real secrets:
  `GUILD_MASTER_KEY_HEX`, `GUILD_JWT_SECRET`). `GUILD_HTTP_PORT=18080`
  because another service already uses 8080. DB/CH/S3 URLs use
  `host.docker.internal:5432/8123/9950`.
- Server state lives in the named volume `guild_data` (`/data` inside the
  container — `GUILD_DATA_DIR`, the server-side workspace sessions root).
  The fullstack fallback volumes (`pgdata`, `chdata`, `miniodata`) still
  hold the pre-cutover data — keep until confident.
  `docker compose down -v` destroys all of it.

### Other stacks on this host

Each stack is its own checkout with its own compose project, database and
object-storage bucket. They share the host Postgres/ClickHouse/S3 services.

| Stack | Checkout | Project | Port | Public host |
|---|---|---|---|---|
| dev | `~/guild` (`deploy/compose`) | `compose` | 18080 | `guild.example.com` |
| prod | `~/guild-live` | `guild-live` | 18081 | `guild.example.org` |
| ezh | `~/guild-stage` | `guild-stage` | 18088 | `ezh.example.com` |

- Dev and prod track `master`; work happens on `develop`.
- Each stack gets fresh `GUILD_MASTER_KEY_HEX`, `GUILD_JWT_SECRET`,
  `GUILD_INTERNAL_KEY` and `GUILD_SANDBOX_RUNNER_TOKEN`, plus its own
  database, ClickHouse database and S3 bucket.
- Sandbox networks must not overlap: dev `10.213.0.0/24`, prod
  `10.215.0.0/24`, ezh `10.216.0.0/24`.
- Agent workspaces are per stack, set in the stack's `.env` with no defaults
  (compose refuses to start without them), see §4b:

  | Stack | `GUILD_WORKSPACE_HOST_DIR` | `GUILD_JUICE_META_DB` | `GUILD_JUICE_VOLUME` | `GUILD_JUICE_BUCKET` | `GUILD_WORKSPACES_VOLUME` |
  |---|---|---|---|---|---|
  | dev (`compose`) | `/mnt/guild-dev` | `guild_meta_dev` | `guild-workspaces-dev` | `guild-workspaces-dev` | `compose_guild_workspaces_dev` |
  | prod (`guild-live`) | `/mnt/guild` | `guild_meta` | `guild-workspaces` | `guild-workspaces` | `guild-live_guild_workspaces` |
  | ezh (`guild-stage`) | `/mnt/guild-stage` | `guild_stage_meta` | `guild-workspaces-ezh` | `guild-workspaces-ezh` | `guild-stage_guild_workspaces` |

  No two stacks may share any of these values.
- Public hosts are ingress rules in `/etc/cloudflared/config.yml` (the
  `cloudflared` tunnel), each pointing at the stack's port. Add a host with
  `cloudflared tunnel route dns <tunnel> <host>` and restart the service.

---

## 2. The big gotcha: the frontend dist is baked into the server IMAGE

The TS server (`apps/server`, `Dockerfile.server-ts`) builds the chat SPA
in a `webui` stage and serves it from disk at `apps/desktop/dist` inside
the image (`GUILD_WEB_DIST` default; `apps/server/src/http/web.ts`):

- **A local `vite build` (or any edit under `apps/desktop/`) does NOT change
  what `http://localhost:18080` serves.** The running container serves
  whatever was baked into its image. Editing files, rebuilding the frontend
  locally, even restarting the container — none of it ships frontend
  changes.
- If the image has no dist, pages answer with the 503 hint ("chat app not
  built") and the API still works.

### Shipping a frontend change (the canonical recipe)

```bash
cd deploy/compose
docker compose build server && docker compose up -d server
```

- The image's `webui` stage runs `npm ci --workspace apps/desktop` + `vite
  build` (it also needs `packages/ui/src` and `packages/wire/src`). Changing
  anything under `apps/desktop/` or
  `packages/ui/` invalidates that stage; the TS compile stage is
  independent, so npm is usually the long pole.
- Backend changes (`apps/server/src`) invalidate the build stage only —
  same recipe.
- For long builds run it detached (see §7).

### Verify the new bundle actually went live

```bash
curl -s localhost:18080/thread/x | grep -oE 'index-[A-Za-z0-9_-]+\.js'
curl -s localhost:18080/api/v1/health          # {"status":"ok"}
```

A changed asset hash = new bundle. Optionally
`docker run --rm --entrypoint sh compose-server-1 -c "ls /app/apps/desktop/dist/assets |
head"` to inspect the served bundle directly.

---

## 3. Dockerfile stage map (`Dockerfile.server-ts` — the live image)

| Stage | Base | Does |
|---|---|---|
| `build` | node:22 | `npm ci --workspace apps/server` (dependencies, assets, migrations; no compile) |
| `webui` | node:22 | `npm ci --workspace apps/desktop` + `vite build` (chat SPA, needs `packages/ui/src` + `packages/wire/src`) |
| runtime | node:22-slim + Bun | production `node_modules` + the server sources + the SPA dist + the static exec-policy rules + migrations; `bun src/index.ts` |

`Dockerfile.sandbox` is the one image that compiles server code: its build
stage runs `npm run build --workspace apps/server` (`tsc`) and copies only
the sandbox agent's emitted files.

Notes:

- npm deps are hoisted via root workspaces; each stage copies
  `package.json`/`package-lock.json` + its apps only — **adding a
  dependency requires the lockfile update to flow through** (lockfile is
  COPYed in every stage).
- Build context is the repo root (`context: ../..`), so anything new the
  build needs must be COPYed explicitly.
- The historical Rust server was removed from the repo (2026-10-13); its
  last state lives in git history. The TS image (`Dockerfile.server-ts`)
  is the only server image.

---

## 4. Compose stack details

- Default `up` starts `server`, `sandbox-runner`, `egress`, `curl-fetch` and
  the build-only `sandbox-image` (exits at once); postgres/clickhouse/minio
  are behind the `fullstack` profile (`--profile fullstack` to use them). The
  server has no compose-service deps — the host services must already be up.
  If the server crash-loops on boot, check the host services first.
- `curl-fetch` (`deploy/curl-fetch`, python + curl_cffi) is `web_fetch`'s
  fallback transport. The server reaches it at `GUILD_CURL_FETCH_URL`
  (`http://curl-fetch:8080`, set by compose). It replays a Chrome TLS and
  HTTP/2 fingerprint for URLs firecrawl cannot return — JSON and plain-text
  endpoints, and pages whose text is too thin for firecrawl's content
  heuristics. It is never published; it answers only on the stack network.
- The fullstack fallback ClickHouse stays pinned to
  `clickhouse-server:24`; the host ClickHouse floats 26.5
  (`pull_policy: always`) — a host CH upgrade can change behavior.
- Registry bundles live in rustfs bucket `guild` (host :9950).
- Restate (the Rust-era durable-execution backend) was removed from compose
  in M3 when the durable engine moved into the TS server on
  pi-durable; its journals in `restate_data` are historical. The
  `restate_data` volume on the host still exists — drop it when the
  pre-cutover confidence window closes.
- Host port override: `GUILD_HTTP_PORT` (18080 here) in `config.env`.
- Server-side agent sessions store under `GUILD_DATA_DIR=/data`
  (`workspaces/<org>/<name>`, plain chats `chats/<org>/<id>`); their tools
  run in gVisor sandboxes — see §4a.

### 4a. Sandboxes (server-side tools)

Design and decisions: `docs/plans/2026-10-14-sandbox-runner-gvisor.md`.

- **Host prerequisite: the `runsc` runtime.** The runner refuses to start
  without it. Install (once per Docker host): unpack a pinned, checksum-
  verified gVisor release (`gvisor.tar.bz2` from
  `storage.googleapis.com/gvisor/releases/release/<ver>/x86_64/`) to
  `/usr/local/lib/gvisor/` (runsc needs `gvisor-bin/` next to it), add
  `"runsc": {"path": "/usr/local/lib/gvisor/runsc", "runtimeArgs":
  ["--overlay2=root:self"]}` under `runtimes` in `/etc/docker/daemon.json`,
  `sudo systemctl reload docker` (a reload, not a restart: running
  containers are untouched). Check: `docker info | grep -i runsc`.
  Verified with gVisor release 20261005.0.
- **config.env** needs `GUILD_SANDBOX_RUNNER_TOKEN` (shared by server and
  runner; `openssl rand -hex 32`). The server gets
  `GUILD_SANDBOX_RUNNER_URL` from compose.
- **Two stacks on one host** (dev `compose`, prod its own project) each need
  their own sandbox subnet and egress IP, set in `deploy/compose/.env`:
  `GUILD_SANDBOX_SUBNET` (default `10.213.0.0/24`) and
  `GUILD_SANDBOX_EGRESS_IP` (default `10.213.0.2`), plus
  `GUILD_SANDBOX_IMAGE` / `GUILD_SANDBOX_EGRESS_IMAGE` tags (`:prod`) so
  one stack's build can't swap the other's images. When Docker's default
  address pools are exhausted, every new network needs an explicit subnet.
- **The egress proxy is addressed by IP**, never by name: Docker's embedded
  DNS does not work inside gVisor sandboxes. The allowlist is
  `deploy/sandbox/egress/allowed-domains.txt` (mounted; `docker compose
  restart egress` after editing).
- **Sandbox containers are not compose services**: `docker ps --filter
  label=guild.sandbox.project=compose`. Idle ones stop after 15 min and
  are removed after 24 h; their files stay on the volume. `docker compose
  down` does not remove running sandboxes — the runner removes its
  project's sandboxes on every start and recreates them on demand.
- **The server runs as uid 1000** (`node`) since the sandbox change; the
  runner hands root-owned data dirs from older volumes to uid 1000 on its
  first boot.
- **Integration tests**: `scripts/sandbox-it.sh` builds `:sbx-it` images
  and runs the runner + e2e suites in a throwaway `guild-sbx-it` project
  (subnets `10.214.0.0/24`, `10.214.1.0/24`; runner on loopback :18090).

### 4b. JuiceFS agent workspaces

Design: `docs/specs/2026-10-18-persistent-agents.md` (decisions 7, 9, 21).

- **Each stack owns its filesystem.** `.env` names it with five values and
  no defaults (table in §1): the host directory, the metadata database, the
  JuiceFS volume name, the bucket, and the Docker volume name. Two stacks on
  one host directory or one metadata database are one filesystem, and one
  stack's unmount takes the other's workspaces down. The sidecar refuses to
  start when another volume is mounted at its host directory.
- **Host prerequisites:** create the bind source and the bucket once per
  stack. No systemd unit is involved.

  ```bash
  sudo mkdir -p /mnt/guild-dev   # GUILD_WORKSPACE_HOST_DIR
  ```

  The compose volume `guild_workspaces` binds that directory;
  `docker compose up` fails at volume creation when it does not exist.
- The `juicefs-init` one-shot service creates `GUILD_JUICE_META_DB` in the
  stack's Postgres from `GUILD_DATABASE_URL` credentials, then exits.
- **The sidecar holds the volume.** Docker unmounts a bind volume when its
  last container stops, and that unmount propagates through the shared
  host directory and takes the FUSE mount down. The `juicefs` service mounts
  `guild_workspaces` itself, so recreating the server and the runner together
  (any deploy that rebuilds the shared image) leaves the mount alone.
- **Never remove or recreate a workspace volume while its directory is
  mounted.** Moving a stack to a new directory means a new
  `GUILD_WORKSPACES_VOLUME` name; the old volume record stays until the old
  directory has no mount, then `docker volume rm` is safe.
- **Credentials:** the JuiceFS settings reach only the `juicefs` service.
  Its object-store key goes in `deploy/compose/juicefs.env`
  (`GUILD_JUICE_ACCESS_KEY`/`GUILD_JUICE_SECRET_KEY`, see
  `juicefs.env.example`); without one it falls back to `config.env`'s
  `GUILD_S3_*`, which the server also holds. Use a RustFS user whose policy
  covers only the stack's bucket (dev: user and policy
  `guild-workspaces-dev`, made with `mcli admin` and the root key from
  `/etc/default/rustfs`). The sidecar stores an explicitly given key in the
  volume on every start, so rotating it is editing `juicefs.env` and
  restarting the sidecar; the `GUILD_S3_*` fallback never replaces a stored
  key.
- The `juicefs` sidecar formats the volume once (`juicefs format` is skipped
  when `juicefs status` reports an existing volume), then mounts it in the
  **host mount namespace**: it runs with `pid: host` and `privileged: true`,
  installs the client at `/usr/local/bin/juicefs` (plus library symlinks under
  `/usr/local/lib/juicefs`) and mounts via `nsenter -t 1 -m -n`. A FUSE mount
  created inside the sidecar's own namespace is not visible to the Docker
  daemon, so it cannot back the per-agent sandbox subpaths. The healthcheck
  runs `nsenter -t 1 -m -- stat -f` on `GUILD_WORKSPACE_HOST_DIR`.
- `server` binds `guild_workspaces` read-only at `/workspaces` (file
  browser, `GUILD_AGENT_WORKSPACE_ROOT`); `sandbox-runner` binds it
  read-write and creates `agents/<org>/<agent>` subpaths for the sandboxes.
  Both wait for the `juicefs` healthcheck and restart with it (`depends_on:
  restart: true`).
- Per-agent quota: the sidecar sweeps `<host dir>/agents/*/*` in the host
  mount namespace every `GUILD_AGENT_QUOTA_INTERVAL` seconds (default 300)
  and runs `juicefs quota set --capacity GUILD_AGENT_WORKSPACE_GIB` (default
  50) for each directory. The sweep needs the host network namespace too, so
  `host.docker.internal` resolves to the host's Postgres.
- Restarting the `juicefs` container replaces the FUSE session behind
  Docker's bind volume (`/var/lib/docker/volumes/<project>_guild_workspaces/_data`).
  The sidecar re-binds that `_data` to the host directory after every mount, so the
  dependent services start on the live mount; the runner also removes its
  sandbox containers on boot, because a sandbox created before the remount
  keeps the dead session (`transport endpoint is not connected`; every
  command in it hangs). Sandbox files live on the volume, so the removal
  loses nothing. Verify by hand if a workspace looks empty or a command
  hangs:

  ```bash
  findmnt -n /var/lib/docker/volumes/compose_guild_workspaces_dev/_data
  ```

  A fresh `docker compose up` on a stack that has never run is unaffected.
- Chat/legacy workspaces stay on `guild_data`; the agent volume is separate.
- The object-storage bucket must already exist before the first
  `juicefs format` (for the isolated instance the init script creates it;
  elsewhere `rclone mkdir` with the stack's key). The sidecar writes `127.0.0.1
  host.docker.internal` into the host `/etc/hosts` when missing, because the
  host-namespace mount resolves the same S3/Postgres names as the
  containers.
- Other stacks can point the services at a different config file with
  `GUILD_CONFIG_ENV=/path/to/config.env` (default `config.env` next to the
  compose file).

**Isolated instance** (`scripts/agents-vfs-init.mjs`) — a disposable
verification stack with fixed resources, never the dev/prod stacks:

| Resource | Value |
|---|---|
| Compose project | `guild-agents-vfs` |
| HTTP port | `18093` |
| App database | `guild_agents_vfs` |
| JuiceFS metadata database | `guild_meta_agents_vfs` |
| JuiceFS volume | `guild-workspaces-agents-vfs` |
| Object-storage bucket | `guild-agents-vfs` |
| Host volume dir | `/mnt/guild-agents-vfs` |
| Workspace volume | `guild-agents-vfs_guild_workspaces` |

Host prerequisites for the isolated instance:

```bash
sudo mkdir -p /mnt/guild-agents-vfs
```

The script refuses any other database, bucket, port, or volume directory.
It provisions the app database, `guild_meta`, the bucket, and the host
directory, then prints how to bring the compose project up with the
isolated config file (`GUILD_CONFIG_ENV`).

---

## 5. First-run / admin plumbing

- Bootstrap (once, until an admin exists):
  `POST /api/v1/auth/bootstrap` with `{"email","password"}`.
- Provider keys & model routes are configured via the admin API (see
  `deploy/README.md` for copy-paste examples) or the admin Settings sections
  in the app at `http://localhost:18080/settings/<section>`.
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

`docker compose build server` can run long (npm + tsc). Use the
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
  (passwordless), pubkey baked into `apps/desktop/src-tauri/tauri.conf.json`.
  The endpoint is the paired server's: `check_and_prepare_update`
  (`apps/desktop/src-tauri/src/lib.rs`) builds
  `<session.base_url>/api/v1/updates/latest.json` and overrides the plugin's
  configured list at runtime, so one client build follows whichever stack it
  paired with. The `endpoints` entry in `tauri.conf.json` is a placeholder
  the runtime replaces. `dangerousInsecureTransportProtocol: true` (plain
  HTTP is intentional for this deployment). `createUpdaterArtifacts: true`.
- Two publisher scripts, both **idempotent** (they delete+republish an
  existing version/platform artifact) and both verify the server's sha256
  against the local file:
  - `scripts/release-clients.sh` — production-format artifacts:
    Windows NSIS installer (cargo-xwin cross-build), Linux AppImage
    (linuxdeploy), macOS DMGs (unsigned). Updater-signed. Heavy build-host
    deps on PATH: zig + cargo-zigbuild, cargo-xwin, macOS SDK at `$SDKROOT`, makensis,
    llvm, linuxdeploy, libdmg-hfsplus, hfsprogs, 7z.
  - Usage: `BASE=http://localhost:18080 TOKEN=<admin-token> VERSION=x.y.z
    VITE_DEFAULT_SERVER_URL=https://guild.example.com scripts/release-clients.sh`.
  - Running the release script from a systemd transient unit needs an explicit
    `-E PATH=...` including `~/.cargo/bin` (cargo-xwin/zigbuild) — the unit's
    default PATH lacks it and the build fails with "cargo-xwin command not
    found" (hit 2026-09-11). Also pass `-E TAURI_SIGNING_PRIVATE_KEY=` for the
    bundler to sign updater artifacts.
- Artifacts land in `/api/v1/releases` (MinIO-backed); the desktop
  updater consumes `latest.json`.
- A server compose rebuild does not create client releases. For each new
  deployment, run `scripts/release-clients.sh` separately with `BASE` pointing
  to that deployment, `VERSION` matching `apps/desktop/src-tauri/tauri.conf.json`,
  and `VITE_DEFAULT_SERVER_URL` set to its public URL. Verify six release rows
  (Windows installer, Linux AppImage, two macOS DMGs, two macOS updater
  archives) and a four-platform `/api/v1/updates/latest.json` response.
- The release script assumes `node_modules` is current: it does NOT run
  `npm ci`. Any commit that adds/moves a frontend dependency (e.g. a new
  `packages/ui` dep) must be followed by `npm ci` in the release checkout,
  or the vite build fails on unresolved imports (hit 2026-10-14 with
  `@fontsource-variable/jetbrains-mono`).
- Local desktop dev: `npm run dev` (vite, port 1420 strict) +
  `npm run tauri dev`; `devUrl` in `tauri.conf.json` points at :1420. The
  GUI hosts the engine in-process (`guild-app-server` is a library
  dependency of `guild-desktop`), so `tauri dev` rebuilds it with the GUI.

---

## 9. Quick recipes

```bash
# ship a frontend or backend change to :18080
cd deploy/compose && docker compose build server && docker compose up -d server

# just restart (e.g. after config.env change)
docker compose up -d server   # recreate if env changed: --force-recreate

# what's actually being served?
curl -s localhost:18080/thread/x | grep -oE 'index-[A-Za-z0-9_-]+\.(js|css)'

# nuke everything including data (destructive!)
docker compose down -v
```

## Daemon watch-items

Maintenance notes for the engine's local socket host (the GUI in-process,
or the `Guild daemon` / `guild-daemon.service` headless host). Check these
when touching releases, tests, or the daemon itself.

1. **Bump the workspace version on every release.** The attach handshake
   (`daemon.hello` → version compare) reads `CARGO_PKG_VERSION` of the
   shared `guild-app-server` lib on both sides, so it only distinguishes
   builds if the workspace `[workspace.package] version` actually moves.
   A stale version makes every daemon look current — a mismatched old
   daemon would never be told to shut down and respawn.

2. **Daemon shutdown is unconditional** (`process::exit(0)` after
   `run_daemon()` in both binaries). Clients holding a socket mid-request
   get dropped connections at shutdown — deliberate: waiting for them
   deadlocks tokio runtime teardown (blocking tasks ↔ client EOF).
   Don't "fix" the exit into a graceful drain without solving that.

3. **Test-hygiene pattern for anything touching the daemon:** every test
   must use a distinct socket path (they collide on PID-derived names when
   run in parallel), clients should set a read timeout (5s) so a
   regression fails fast instead of hanging the suite, and a fake server
   on a socketpair must hold its end open until the client closes (early
   close = EPIPE/EOF races; also: writes to one end arrive at the OTHER
   end — crossed ends make the client read back its own requests).

4. **Overrides for dev:** `GUILD_DAEMON_SOCKET` (socket/pipe path).
   Release builds use `cargo xwin check` (msvc) and `cargo zigbuild --lib` (apple) as
   compile gates; full binary links happen in the release pipeline
   (Windows SDK / macOS SDK needed there).

## 10. Version sync — one product version everywhere (mandatory)

The product carries a single version (the one in `Cargo.toml`'s
`[workspace.package]`). It must be the
same in every place it lives; the health endpoint, the updater manifest
checks and the release scripts all compare against it, so drift reads as a
mismatched client or a stale server.

The complete list of places:

| File | What it versions |
|---|---|
| `Cargo.toml` (`[workspace.package] version`) | every workspace crate: `protocol`, `guild-core`, `app-server`, and the desktop (`version.workspace = true`) |
| `apps/desktop/src-tauri/tauri.conf.json` | desktop updater bundle version |
| `apps/desktop/package.json` | desktop SPA build; the release manifests use it |
| `apps/server/package.json` | TS server; `GUILD_TS_SERVER_VERSION` reads it → `/api/v1/health` |
| `packages/ui/package.json` | shared UI kit |

**Update them with the script, never by hand** — it also refreshes both
Cargo lockfiles (`cargo update -w` touches only workspace members):

```bash
scripts/bump-version.sh 0.5.38
```

Deliberately NOT synced: every external dependency in the
`[workspace.dependencies]` table.

When a release bumps the version, run the script first, commit, then
follow `docs/clients.md`'s release flow (`scripts/release-clients.sh` with
the same `VERSION`).
