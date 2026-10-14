# Server-side sandboxes — gVisor + sandbox-runner (Docker, single host)

Date: 2026-10-14. Status: **phases 0–2 implemented** (branch `sandbox-runner`);
phases 3–4 open. Scope: the docker-compose deployment with everything on
one host. Kubernetes is out of scope; the runner's Docker calls sit behind
`SandboxManager`, so a Pod backend can replace them later without touching
the server.

## Why

Server-side tools ran in the Fastify process. `harness/runtime.ts` returned
`new NodeExecutionEnv({ cwd })` for workspace sessions and plain chats, and
pi-durable's env resolves absolute and `~` paths as-is
(`env/node.js:33-46`): `cwd` was a starting folder, not a boundary. Any
member with a full-access chat (or who approved their own card) could read
`/proc/self/environ` (master key, DB URL, internal key) and, with the image
running as root, overwrite `/app/dist`. Workspace sessions skip the
approval gate for read/write/edit (`approvals.ts:300`). Full-review
finding #1, 2026-10-14.

The fix is a kernel boundary, not path checks: model-driven file and shell
access runs in per-workspace gVisor containers that see only their own
workspace, reach the network only through an allowlisting proxy, and hold
no secrets.

## Architecture

```
 server (uid 1000)                sandbox-runner (root)          sandbox (runsc, uid 1000)
 ─────────────────                ─────────────────────          ─────────────────────────
 SandboxExecutionEnv ──HTTP/WS──▶ ensure / rpc / stop ──docker──▶ node /opt/guild/agent.js
   (ExecutionEnv proxy)           holds docker.sock               NodeExecutionEnv{cwd:/workspace}
                                  fixes the container spec        /workspace = guild_data subpath
                                                                  net: <project>_sandbox → egress
```

- **The agent runs inside the sandbox** and wraps pi-durable's own
  `NodeExecutionEnv` with `cwd: /workspace`. Tool semantics stay identical
  (pi-durable's env conformance suite passes in-process and inside a real
  gVisor sandbox); confinement comes from the container.
- **No inbound network path.** The runner execs the agent per connection
  and bridges the exec stdio stream to the server's WebSocket; the server
  never joins a sandbox network.
- **The server never holds the Docker socket.** The runner takes a key and
  a workspace subpath (both validated) and nothing else; image, mounts,
  runtime, user, limits and network are runner config.

### Code

All in `apps/server/src/sandbox/` (one package, one image for server and
runner):

| File | What |
|---|---|
| `protocol.ts` | Frames (one JSON per line), value codec (bytes, undefined, `FileError`/`ExecutionError`), `Wire`, `LineSplitter`. |
| `serve.ts` | Agent side: serves an `ExecutionEnv` on a `Wire`; handles for readers/watchers; exec output and watch events; cancel → abort. |
| `agent.ts` | The in-sandbox entry (stdin/stdout wire, `GUILD_SANDBOX_CWD`). |
| `env.ts` | `SandboxExecutionEnv`: the server-side proxy; lazy connect, reconnect on next call, in-flight calls fail "connection lost; outcome unknown" on a drop. |
| `client.ts` | `RunnerClient` (HTTP + WS) and `SandboxPool` (one env per sandbox key, idle disconnect, connect hook). |
| `runner/spec.ts` | The container policy and runner config (pure; unit-tested). |
| `runner/manager.ts` | Ensure/attach/stop/remove, LRU capacity, idle reaper, adopt-on-boot, data-root ownership. |
| `runner/docker.ts` | Docker Engine API over the unix socket, hijacked exec stream demux. |
| `runner/main.ts` | The runner's HTTP/WS server. |

Images: `Dockerfile.sandbox` (node:22-bookworm + ripgrep, jq, python3
pip/venv/dev, pkg-config, libssl-dev; the agent and its two deps in
`/opt/guild`), `deploy/sandbox/egress/` (squid). The runner runs from the
server image (`command: node dist/sandbox/runner/main.js`, `user: 0:0`).

## Runner contract

Bearer `GUILD_SANDBOX_RUNNER_TOKEN` on every call; listens on the compose
default network only.

- `POST /v1/sandboxes {key, subpath}` → `{name, state}`: idempotent ensure
  (running → as is; stopped → started; missing → created). `subpath` must
  match `^(workspaces|chats)/<uuid>/[A-Za-z0-9_-]{1,64}$`; the dir is
  created under the runner's `/data`, refused if it resolves elsewhere, and
  handed to uid 1000.
- `GET /v1/sandboxes/:name/rpc` (WS) → one agent process per connection.
  Names must be `guild-sbx-<project>-<hash>` and carry this runner's
  project label (foreign containers: 400/404).
- `POST /v1/sandboxes/:name/stop`, `DELETE /v1/sandboxes?key=…`,
  `GET /v1/healthz`.
- Boot refuses a runtime other than `runsc` unless
  `GUILD_SANDBOX_ALLOW_RUNC=1`, and refuses proxied mode without
  `GUILD_SANDBOX_PROXY_URL` given as an IP address.

Container spec: `--runtime=runsc`, network `<project>_sandbox` (or
`none`), `--user 1000:1000`, `--read-only`, `--tmpfs /tmp`,
`--cap-drop ALL`, `no-new-privileges`, pids/memory/cpu limits, `--init`,
the volume subpath at `/workspace`, labels `guild.sandbox.*`. The env holds
only the sandbox home, package-manager dirs and proxy variables.

Lifecycle: stop after `GUILD_SANDBOX_IDLE_STOP_SECONDS` (900) without an
attached connection, remove after `GUILD_SANDBOX_IDLE_REMOVE_SECONDS`
(86400); state lives on the volume, so removal loses nothing.
`GUILD_SANDBOX_MAX_RUNNING` (32) stops the least-recently-used idle
sandbox before starting another (503 when none is idle). On boot the
runner adopts its project's containers. The server's pool drops a
connection after 5 minutes unused, so the runner can count it idle.

## Storage

- The existing `guild_data` volume; the runner derives its Docker name as
  `<compose project>_guild_data` from its own container labels (no rename:
  existing deployments keep `compose_guild_data`, `guild-live_guild_data`).
- Workspace sessions: `workspaces/<org>/<name>` (unchanged). Plain chats:
  `chats/<org>/<conversationId>` (was container-local
  `/tmp/guild-sandboxes/<id>`, lost on every redeploy). Chats are never
  deleted by the app today, so their dirs persist like workspace dirs.
- Ownership: the server now runs as uid 1000 (`node`), the sandbox uid. The
  runner hands `/data`, `/data/workspaces`, `/data/chats` (recursively,
  once, when root-owned) and every new subpath to uid 1000.
- No per-sandbox disk quota (plain volume). Open question.

## Server changes

- `config.ts`: `GUILD_SANDBOX` = `runner` | `inprocess-unsafe` | `disabled`.
  Default: `runner` when `GUILD_SANDBOX_RUNNER_URL` is set, else `disabled`
  in production and `inprocess-unsafe` elsewhere (the test suite);
  `inprocess-unsafe` is refused in production. `GUILD_ALLOW_SHELL_TOOLS`
  defaults to on in runner mode.
- `harness/runtime.ts`: one `envForConversation` serves the harness env
  factory and the skills runtime; runner mode returns the pooled
  `SandboxExecutionEnv` (no container until a tool actually runs), skills
  are materialized once per fresh agent connection (pool connect hook).
- `harness/skills.ts`: materialize, read and push go through the
  conversation's `ExecutionEnv`, never host paths — a symlink a sandbox
  plants cannot redirect a server-side write. Skill slugs are validated
  (`^[a-z0-9_-]{1,64}$`) before they become path segments (closes the
  `read_skill` traversal finding).
- `platform/http/agents.ts`: workspace reclaim removes the old sandbox
  container first and refuses a symlinked workspace root.
- `platform/store/thread.ts`: U+0000 in event strings becomes U+FFFD (jsonb
  cannot hold it). Found by the e2e test: a tool reading
  `/proc/self/environ` broke thread journaling and left the chat
  generating forever — any NUL-bearing tool output did.
- `Dockerfile.server-ts`: `USER node`.

## Package installs

- Project-local installs (`node_modules`, `.venv`, `target/`) live in
  `/workspace`.
- User-level installs persist in `/workspace/.sandbox-home` (`HOME`,
  `npm_config_prefix`, `PYTHONUSERBASE`, `CARGO_HOME`, caches; their bin
  dirs on `PATH`; `PIP_BREAK_SYSTEM_PACKAGES=1` since system site-packages
  are read-only anyway). `npm i -g` and `pip install --user` work and
  survive container removal (integration-tested).
- System packages are baked into the image; `apt-get` does not work
  (non-root, read-only rootfs) by design.

## Network

- Sandboxes join only `<project>_sandbox` (`internal: true`: no gateway,
  no host, no compose services).
- `egress` (squid) sits on both networks at a **fixed address**
  (`GUILD_SANDBOX_EGRESS_IP`, default `10.213.0.2`), and sandboxes get
  `HTTP(S)_PROXY=http://<ip>:3128`. By address because Docker's embedded
  DNS (127.0.0.11, iptables-redirected inside the container netns) does
  not work under gVisor's netstack; proxied clients need no DNS of their
  own (CONNECT carries the hostname).
- Explicit subnet for the sandbox network (`GUILD_SANDBOX_SUBNET`, default
  `10.213.0.0/24`): hosts with many compose projects exhaust Docker's
  default pools. Stacks sharing a host pick distinct subnets/IPs (prod:
  set both in `deploy/compose/.env`).
- Squid allowlist `deploy/sandbox/egress/allowed-domains.txt` (npm, yarn,
  PyPI, crates.io, Go proxy; mounted, editable per deployment;
  `github.com` deliberately absent). After DNS resolution squid denies
  RFC1918, loopback, link-local, CGNAT and multicast destinations — the
  host's Postgres/ClickHouse/RustFS listen on 0.0.0.0.
- `GUILD_SANDBOX_NETWORK_MODE=none` drops networking entirely.

## Host setup (one-time, per Docker host)

1. gVisor release (pinned, checksum-verified) unpacked to
   `/usr/local/lib/gvisor/` (`runsc`, `containerd-shim-runsc-v1`,
   `gvisor-bin/` — runsc needs its helpers next to it).
2. `/etc/docker/daemon.json` `runtimes.runsc = {path:
   /usr/local/lib/gvisor/runsc, runtimeArgs: ["--overlay2=root:self"]}`,
   then `systemctl reload docker` (SIGHUP: running containers untouched).
3. Smoke: `docker run --rm --runtime=runsc node:22-slim uname -r` →
   `4.19.0-gvisor`.

Done on `devbox` 2026-10-14 (release 20261005.0; daemon.json backup
`/etc/docker/daemon.json.bak-20261014-pre-gvisor`).

## Phases

- **0 — done.** Slug validation; server image non-root.
- **1 — done.** Protocol, agent, image, runner, egress, server wiring,
  fail-closed config, plain-chat dirs on the volume.
- **2 — done.** Skill materialize/read/push through the env; reclaim
  hardening.
- **3 — open.** Per-org network mode and allowlist additions (admin UI);
  registry mirrors (Verdaccio/devpi) instead of direct egress.
- **4 — open.** Warm pool, per-org running caps, metrics (start latency,
  running count, disk per org), admin view of running sandboxes,
  Kubernetes backend.

## Tests

- `src/test/sandbox/env-conformance.test.ts` — pi-durable's env
  conformance suite through `SandboxExecutionEnv` ↔ in-process agent.
- `src/test/sandbox/runner-spec.test.ts` — subpath/key validation, the
  container spec, config refusals, wire codec, frame splitting.
- `scripts/sandbox-it.sh` — builds the images, starts a throwaway
  `guild-sbx-it` project (runner + egress, real runsc), runs:
  - `runner.it.test.ts`: confinement (gVisor kernel, uid, no runner env,
    no `/data`/docker socket/other workspaces, read-only rootfs), network
    (no direct route, allowlist through the proxy, private/host addresses
    refused), npm/pip installs local and global, persistence across
    container removal, runner API auth and validation, lifecycle,
    connection loss, and the conformance suite inside a real sandbox.
  - `server-e2e.it.test.ts`: the real app + harness + scripted model; a
    workspace-session `bash` turn and a plain-chat `read` of
    `/proc/self/environ` run in sandboxes and see none of the server's
    secrets.

## Open questions

1. Plain chats: one sandbox per conversation (implemented) or per user?
2. Sandbox image contents beyond the basics (Rust toolchain?).
3. Org-provided sandbox images — not in v1.
4. Disk quotas (XFS project quotas on the volume?).
