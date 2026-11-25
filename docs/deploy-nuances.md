# Guild — deploy nuances

Everything non-obvious about building, serving, and shipping Guild on the
k3s cluster on this host. Companion to `docs/clients.md` (client
distribution details) and `deploy/kubernetes/README.md` (chart install and
upgrade).

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
  /`_SECRET_ACCESS_KEY`). There are no testcontainers.
- The server pod reaches these ports by the host's LAN address; they are
  part of the cluster's `guild-server` Secret.
- Tests that talk to these services read their credentials from the
  environment, then from the gitignored `test.env` at the repo root
  (`GUILD_S3_SECRET_ACCESS_KEY`, `GUILD_CLICKHOUSE_USER`,
  `GUILD_CLICKHOUSE_PASSWORD`).

---

## 1. The cluster installation

Guild runs on the k3s cluster on this host. One installation, no second
stack.

| Part | Value |
|---|---|
| Namespace | `guild-dev` |
| Deployment | `guild`, container `server` |
| Image | `guild-server-ts:<source commit>`, `imagePullPolicy: Never` |
| Public entry | NodePort `30080`, tunneled at the dev public host |
| Configuration | the `guild-server` Secret in the namespace |

- The Cloudflare tunnel rule in `/etc/cloudflared/config.yml` points the
  public host at `http://127.0.0.1:30080`.
- The Secret carries `GUILD_DATABASE_URL`, `GUILD_CLICKHOUSE_URL`,
  `GUILD_S3_URL`, `GUILD_MASTER_KEY_HEX`, `GUILD_JWT_SECRET`,
  `GUILD_INTERNAL_KEY`, `GUILD_SANDBOX_RUNNER_TOKEN` and the release
  settings. Change configuration there, not in a file in this repo.
- The pod reaches the host services of §0 by the host's LAN address.
- The chart and its install procedure live in `deploy/kubernetes/README.md`;
  that document is the source of truth for the cluster.

### Deploy a build

```bash
# 1. build the image from the checkout, stamped with the version it serves
docker build -f Dockerfile.server-ts \
  --build-arg GUILD_BUILD_VERSION=<version> \
  -t guild-server-ts:<commit> .

# 2. load it into the cluster's containerd (the deployment never pulls)
docker save guild-server-ts:<commit> | sudo k3s ctr images import -

# 3. point the deployment at it and wait
kubectl -n guild-dev set image deploy/guild server=guild-server-ts:<commit>
kubectl -n guild-dev rollout status deploy/guild --timeout=10m

# 4. check what is served
curl -s -H 'Host: <public host>' http://127.0.0.1:30080/api/v1/health
```

The Docker build stamps `GUILD_BUILD_VERSION` into the server package.
Health, WebSocket identity and release eligibility all read that baked
version. The source manifests keep the stable product version.

---

## 2. The big gotcha: the frontend dist is baked into the server IMAGE

The TS server (`apps/server`, `Dockerfile.server-ts`) builds the chat SPA
in a `webui` stage and serves it from disk at `apps/desktop/dist` inside
the image (`GUILD_WEB_DIST` default; `apps/server/src/http/web.ts`):

- **A local `vite build` (or any edit under `apps/desktop/`) does NOT change
  what the cluster serves.** The running pod serves whatever was baked into
  its image. Editing files, rebuilding the frontend locally, even restarting
  the pod — none of it ships frontend changes.
- If the image has no dist, pages answer with the 503 hint ("chat app not
  built") and the API still works.

### Shipping a frontend change (the canonical recipe)

```bash
docker build -f Dockerfile.server-ts -t guild-server-ts:<commit> .
docker save guild-server-ts:<commit> | sudo k3s ctr images import -
kubectl -n guild-dev set image deploy/guild server=guild-server-ts:<commit>
kubectl -n guild-dev rollout status deploy/guild --timeout=10m
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
curl -s -H 'Host: <public host>' http://127.0.0.1:30080/thread/x \
  | grep -oE 'index-[A-Za-z0-9_-]+\.js'
curl -s -H 'Host: <public host>' http://127.0.0.1:30080/api/v1/health
```

A changed asset hash = new bundle. Optionally
`kubectl -n guild-dev exec deploy/guild -- ls /app/apps/desktop/dist/assets | head`
to inspect the served bundle directly.

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

---

## 4. Cluster specifics

- The chart (`deploy/kubernetes/chart`) installs the server, the fetch
  service, the Substrate adapter, the actor worker pool, JuiceFS and the
  workspace CSI. `deploy/kubernetes/README.md` is the install and upgrade
  procedure.
- Server-side tools run in gVisor sandboxes created by the Substrate actor
  workers, never in the server pod; see `docs/domain/003-execution.md`.
- Agent workspaces and plain chats mount through the workspace CSI.
- `curl-fetch` (`deploy/curl-fetch`, python + curl_cffi) is `web_fetch`'s
  fallback transport, reached at `GUILD_CURL_FETCH_URL`. It replays a Chrome
  TLS and HTTP/2 fingerprint for URLs firecrawl cannot return: JSON and
  plain-text endpoints, and pages whose text is too thin for firecrawl's
  content heuristics. It is never published outside the cluster.
- Registry bundles live in the installation's S3 bucket.
- Server-side agent sessions store under `GUILD_DATA_DIR`
  (`workspaces/<org>/<name>`, plain chats `chats/<org>/<id>`).

---

## 5. First-run / admin plumbing

- Bootstrap (once, until an admin exists):
  `POST /api/v1/auth/bootstrap` with `{"email","password"}`.
- Provider keys & model routes are configured via the admin API (see
  `deploy/README.md` for copy-paste examples) or the admin Settings sections
  in the app at `/settings/<section>`.
- Desktop pairing: generate a code in the web app (Settings → Connect
  desktop app); the desktop client pairs against the public host.

---

## 6. PWA / service worker (rarely the culprit)

`apps/desktop/public/sw.js`, cache name `guild-shell-v2`:

- **Network-first** for all same-origin GETs (except `/api/` — always
  passthrough): fresh response when online, cache only as offline fallback,
  successful responses refresh the cache.
- So a stale UI after deploy is almost never the SW — it's the
  embed-at-build-time binary (§2). A plain reload picks up new index.html
  fine.
- Known console noise: `/favicon.ico` and `/icon-192.png` return 503 from
  the server on some loads — cosmetic bug in the server's static/asset
  handling, not a deploy problem.

---

## 7. Running long rebuilds detached

`docker build -f Dockerfile.server-ts` can run long (npm + tsc). Use the
`big-job` skill (systemd-run transient unit, journal output). Two traps:

- **No shell operators after `systemd-run --`** — `a && b` becomes literal
  args. Wrap: `-- bash -lc 'cd ~/guild && docker build -f
  Dockerfile.server-ts -t guild-server-ts:<commit> .'`.
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
  - `scripts/release-clients.sh` — local cross-build entry point. It delegates
    preview stamping and publication to `scripts/release.mjs`; see `docs/clients.md` §4.
- Desktop artifacts are published once to GitHub Releases. Each stack imports
  an approved tag using `POST /api/v1/admin/releases/github`. Set
  `GUILD_RELEASE_REPOSITORY=owner/repository`; set `GUILD_RELEASE_CHANNEL=develop`
  on dev to allow preview versions. The default stable channel rejects them.
- The paired server keeps `/api/v1/updates/latest.json` and the release download
  API, with GitHub URLs for imported releases. Verify the approved version and
  all four updater targets after importing. Approval requires no client rebuild.
- Release builds need current node dependencies and an explicit full `PATH`
  when run detached. The local builder installs isolated dependencies and shares npm and Cargo caches.
- Local desktop dev: `npm run dev` (vite, port 1420 strict) +
  `npm run tauri dev`; `devUrl` in `tauri.conf.json` points at :1420. The
  GUI hosts the engine in-process (`guild-app-server` is a library
  dependency of `guild-desktop`), so `tauri dev` rebuilds it with the GUI.

---

## 9. Quick recipes

```bash
# ship a frontend or backend change: build, import, roll (see §1)
docker build -f Dockerfile.server-ts --build-arg GUILD_BUILD_VERSION=<version> \
  -t guild-server-ts:<commit> .
docker save guild-server-ts:<commit> | sudo k3s ctr images import -
kubectl -n guild-dev set image deploy/guild server=guild-server-ts:<commit>
kubectl -n guild-dev rollout status deploy/guild --timeout=10m

# what's actually being served?
curl -s -H 'Host: <public host>' http://127.0.0.1:30080/thread/x \
  | grep -oE 'index-[A-Za-z0-9_-]+\.(js|css)'

# logs
kubectl -n guild-dev logs deploy/guild -f
```

## Daemon watch-items

Maintenance notes for the engine's local socket host (the GUI in-process,
or the `Guild daemon` / `guild-daemon.service` headless host). Check these
when touching releases, tests, or the daemon itself.

1. **Every build carries its release version.** Stable product versions are
   committed only by the master release workflow. Branch builds stamp a temporary
   `-dev.<build-number>` version in an isolated checkout. The attach handshake
   reads `CARGO_PKG_VERSION`, so previews also distinguish running engines.

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

**Stable version commits belong to the master release workflow.** It invokes
`scripts/bump-version.sh <semver>` to update all manifests and lock entries before
building. CI checks synchronization and rejects version changes on other branches,
except synchronization from master. Local and branch releases stamp a temporary
next-patch `-dev.<build-number>` version with `--build` in a disposable checkout.
See `docs/clients.md` §4 for publication and per-stack approval.

A develop preview reaches the cluster as a server image stamped with the
preview version (§1), and the release is approved on that installation after
health reports the stamped version. Daily GitHub cleanup preserves the newest
ten previews, all previews under fourteen days old, and installation pins; see
`docs/clients.md` §4. Stable releases are retained.
