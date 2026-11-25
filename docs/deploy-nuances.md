# Guild — deploy nuances

Build, deploy, and verify Guild on Kubernetes. See [desktop client releases](clients.md)
and the [Helm install guide](../deploy/kubernetes/README.md).

## 0. Backing services

The installation supplies PostgreSQL, ClickHouse, and S3-compatible storage.
Use the installation's values and Secrets to configure service endpoints and
credentials as described in the Helm install guide.

Guild proxies browser telemetry through the server: `POST /faro/collect`
forwards to `GUILD_FARO_URL` (an empty value disables forwarding).
The switch is the workspace's: `telemetry_enabled` in `org_kv`, **on when
absent**, admin-only (`Settings → General`, `PUT /api/v1/org/telemetry`).
The value rides the `workspace_identity` frame, so every client starts or
stops collecting live. There is no per-device toggle; About shows the state
read-only.

Tests use isolated databases and buckets on the configured test services.
Override endpoints via `GUILD_TEST_PG_URL`, `GUILD_TEST_CLICKHOUSE_URL`, and
`GUILD_TEST_S3_URL`. Supply test credentials through the environment or the
gitignored `test.env` at the repository root.

---

## 1. Build and deploy the server

Set `version` to the product version for a stable release or to the intended
preview version for a develop installation. Set `image` to an immutable image
reference that identifies this build. From the repository root, build the image.

```bash
docker build -f Dockerfile.server-ts \
  --build-arg "GUILD_BUILD_VERSION=${version:?Set the server version}" \
  -t "${image:?Set the server image reference}" .
```

Publish the image to the installation's registry, or load it onto the eligible
nodes when the installation uses preloaded images. Set `images.server` to the
image reference in the installation's managed Helm values. For a first
installation, follow the [Helm setup guide](../deploy/kubernetes/README.md#apply-and-verify).
For an existing installation, set `chart`, `context`, `namespace`, and
`values` to the chart, kube context, release namespace, and maintained values
file. Set `BASE` to the deployed origin.

```bash
helm upgrade guild "$chart" --kube-context "$context" \
  --namespace "$namespace" -f "$values" --wait --timeout 10m
```

Verify the reported version at the deployed origin.

```bash
curl -fsS "$BASE/api/v1/health" \
  | jq -e --arg version "$version" '.status == "ok" and .version == $version'
```

Health, WebSocket identity, and release eligibility use the version baked into
the image. When deploying a paired desktop release, use the
[release pairing procedure](clients.md#pairing-a-deployment-with-a-desktop-release).
For a published preview, create its pending pin before the Helm upgrade.

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

### Shipping a frontend change

Use the [version-stamped server build and Helm rollout](#1-build-and-deploy-the-server)
for frontend and backend changes.

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
curl -fsS "$BASE/thread/x" | grep -oE 'index-[A-Za-z0-9_-]+\.js'
```

Compare the served asset hash with the bundle in the new image.

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
- Build context is the repo root, so anything new the
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

Run the stamped build from §1 in a detached systemd transient unit with an
explicit working directory. Follow the unit's journal and check its exit status
before deploying the image.

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
  the runtime replaces. `createUpdaterArtifacts: true`.
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
kubectl --context "$context" -n "$namespace" logs deploy/guild -f
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

The desktop release paired with a deployment matches the version reported by
the running server. Daily GitHub cleanup preserves the newest
ten previews, all previews under fourteen days old, and installation pins; see
`docs/clients.md` §4. Stable releases are retained.
