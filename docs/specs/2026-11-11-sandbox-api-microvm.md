# Sandbox API — a docker-less sandbox service on Cloud Hypervisor

Status: **draft**, 2026-11-11. Replaces the Docker backend of
`docs/plans/2026-10-14-sandbox-runner-gvisor.md`; the server-side seam it
describes stays. Research behind the choice:
`docs/plans/2026-11-11-microvm-sandbox-options.md`.

## Why

The sandbox exists to hold model-driven code. It ran on gVisor (`runsc`),
inside a Docker container, one per workspace. That holds until the code needs
a real kernel: a headless Chromium render hung on `about:blank` for 21
minutes, and `--single-process` died in `check.cc`. An agent that must look at
a page cannot do it today.

Two conclusions came out of that:

1. The boundary has to be a VM, not a user-space kernel.
2. Docker is the wrong long-term interface. It is a container API. Pause,
   snapshot, restore and fork have no place in it, and we now want all four.

So the seam moves: the server talks to a **sandbox API**, and the API is
served by a sandbox service that happens to run Cloud Hypervisor microVMs.
Docker and `runsc` become one backend of that API, then none.

## What stays

- **The server-side seam.** `SandboxExecutionEnv` and `RunnerClient`
  (`apps/server/src/sandbox/`) are what the harness sees. The harness keeps
  calling `ExecutionEnv` methods and never learns what runs underneath.
- **The workspace volume.** `/mnt/guild/<subpath>`, mounted by the JuiceFS
  sidecar in the host namespace, reaches the sandbox as a directory.
- **The egress proxy.** squid on a fixed IP, registry allowlist, private
  destinations denied. It stays the only way out.
- **The line protocol.** `agent.js` inside the sandbox speaks the same lines
  over the same channel; only the transport under it changes (exec stream
  today, vsock later).
- **The policy above it.** Exec policy, the approval judge, and the tool
  classes do not move.

## The API (v1)

The contract is keyed, not named. The server addresses a sandbox by key
(`agent:<org>:<agent>`, `chat:<org>:<chat>`); the backend returns an opaque
id and the server never stores it.

| Method | Path | Meaning |
|---|---|---|
| GET | `/v1/healthz` | backend kind, image digests, capacity |
| POST | `/v1/sandboxes` | `{key, subpath}` → ensure, create if missing |
| GET | `/v1/sandboxes/:key` | state, started at, resources |
| POST | `/v1/sandboxes/:key/stop` | stop, keep disk |
| POST | `/v1/sandboxes/:key/pause` | freeze, keep memory |
| POST | `/v1/sandboxes/:key/resume` | unfreeze |
| POST | `/v1/sandboxes/:key/snapshot` | `{label}` → snapshot id |
| POST | `/v1/sandboxes` | `{key, subpath, from_snapshot}` → restore |
| DELETE | `/v1/sandboxes/:key` | remove |
| WS | `/v1/sandboxes/:key/rpc` | attach the agent process |

Rules that outlive the backend:

- **Idempotent ensure.** `POST /v1/sandboxes` on a live sandbox returns it
  unchanged. On a stopped one it starts it.
- **Errors are typed.** 409 name collision, 404 missing, 503 capacity or a
  dead volume, 400 bad key or subpath. The server retries 503, and nothing
  else.
- **Keys and subpaths are validated by the service**, not by the caller. The
  existing regexes move into the service unchanged.
- **No path crosses the API.** Files move through the RPC, never as HTTP
  bodies. The one exception is attachments, which already have their own
  route.

Pause, resume, snapshot and restore are declared now and may answer `501` on
the Docker backend. That is deliberate: the API is the contract, the backends
differ.

## The Cloud Hypervisor backend

One sandbox is four host processes plus a guest:

```
workspace subpath ──▶ virtiofsd ──┐
                                  ├──▶ cloud-hypervisor ──▶ guest kernel
rootfs (erofs, ro) + overlay ─────┘                          └── agent.js
egress proxy ◀── TAP ────────────────────────────────────────┘
```

- **`virtiofsd`** exports exactly one directory: the sandbox's workspace
  subpath. One daemon per sandbox, scoped, `--sandbox=namespace`.
- **`cloud-hypervisor`** runs with `--fs tag=workspace`, `--vsock`,
  `--net tap=<tap>`, `--api-socket`, and the rootfs as a read-only erofs
  device plus a per-sandbox ext4 overlay.
- **The guest** boots a pinned kernel and init, mounts the virtio-fs share at
  `/workspace`, and starts `agent.js` on a vsock port. The agent speaks the
  existing line protocol.
- **The TAP** joins `<project>_sandbox`, so the guest sees the proxy and
  nothing else. nftables denies private and link-local ranges for non-HTTP
  traffic, replacing the squid destination check.
- **Resources** are a cgroup v2 around the CH process: `memory.max` at VM
  memory plus 256 MiB, `pids.max`, and CPU weight. vCPU count and guest RAM
  are per-sandbox settings, not host knobs.

### Boot, snapshot, restore

Boot is the cost we pay to get a real kernel. The lever is one boot, many
restores:

1. Boot the base image once per image digest, wait for `agent.js` to answer.
2. Snapshot that state (`config.json`, `state.json`, `memory-ranges`).
3. Every new sandbox restores from it with
   `memory_restore_mode=ondemand`, so pages fault in as they are touched.

A restore is a few tens of milliseconds of VMM work, not a kernel boot. The
snapshot is a full RAM dump, so the base snapshot is one file shared by every
restore — not one per sandbox.

### Storage layout

| What | Where | Lifetime |
|---|---|---|
| Base rootfs, per image digest | `/data/sandbox/images/<digest>` | until the digest is dropped |
| Base snapshot, per image digest | `/data/sandbox/snapshots/base-<digest>` | as above |
| Per-sandbox overlay | `/data/sandbox/overlays/<key>` | with the sandbox |
| Sandbox workspace | `/mnt/guild/<subpath>` | permanent |
| Browser profile | guest tmpfs | with the VM |

Nothing that a sandbox installs goes on the workspace volume. The overlay is
local disk and is discarded with the sandbox.

## Migration phases

**Phase 0 — today.** Docker + `runsc`, one container per sandbox, browser
impossible.

**Phase 1 — extract the API.** Rename the runner to `sandboxd`. Introduce a
`SandboxBackend` interface with one implementation, `DockerBackend`, holding
the current `SandboxManager` code. The HTTP surface gains the new verbs
(`GET :key`, `pause`, `resume`, `snapshot`) and answers `501` where Docker
cannot comply. No behavior change; the server keeps working untouched.

**Phase 2 — the CH backend, one sandbox type.** Add `HypervisorBackend`. Use
it first for a new sandbox type: `browser`, created on demand when an agent
needs to render or drive a page. Chat workspaces stay on Docker. This proves
virtio-fs over JuiceFS, the vsock agent, and the proxy path without risking
the main tool loop.

**Phase 3 — flip agent sandboxes.** Agent sandboxes move to CH. Chat
workspaces follow once throughput on many small files is measured and
acceptable.

**Phase 4 — delete `DockerBackend`.** `runsc` leaves the compose file; the
Docker socket leaves the sandbox service; `Dockerfile.sandbox` becomes a
rootfs build recipe.

Each phase ships behind its own deploy and can be reverted by config.

## Garbage collection

The container backend has four collection points. This design keeps them and
adds one.

1. **Images.** Content-addressed by digest, pinned in config, pruned to the
   last N digests by a sweep.
2. **Base snapshots.** One per live digest. Dropped with the digest.
3. **Per-sandbox overlays and VM state.** Removed with the sandbox.
4. **Sandboxes.** Idle stop after 15 minutes, remove after 24 hours — the
   same knobs as today. Agent sandboxes stay always-on.
5. **Named snapshots (new).** A per-sandbox snapshot is a full RAM dump. It
   needs a TTL (24 hours), a per-agent cap (3), and a size check before the
   write. Without these, `/data` fills silently.

Orphan sweep at boot: every CH process without a registry row is killed, and
every registry row without a process is marked stopped. This replaces
`removeStale`, which today relies on Docker labels.

## Security

- CH runs as a non-root user in its own cgroup, with no Docker socket in
  sight. The sandbox service is the only process with `/dev/kvm`.
- Kernel, initramfs and rootfs are pinned by digest and verified on load.
- virtiofsd exports one directory and nothing else; `noexec` where the
  workload allows it.
- The guest has vsock for control and one TAP for egress. It cannot open a
  connection to the host.
- The approval judge and exec policy do not change. They sit above the
  sandbox and never see the backend.

## Open questions

- **virtio-fs over JuiceFS throughput.** Every guest read is virtiofsd → FUSE
  → JuiceFS. `rg`, `npm i` and `git status` are the benchmark, not `dd`.
- **uid mapping.** Guest uid 1000 reaches the host through virtiofsd. Decide
  the mapping before the volume is shared with real data.
- **Snapshot timing.** Base snapshot at first boot per digest, or pre-built
  at image publish time? The second is faster and makes deploys heavier.
- **Always-on at 2 GiB.** Thirty-two always-on agent VMs is 64 GiB of guest
  RAM. Either shrink the default or make agent sandboxes snapshot-and-stop.
- **Boot budget.** A restore is fast, but the first tool call of a turn must
  not wait on a cold image pull.

## Work breakdown

| Step | Size | Notes |
|---|---|---|
| `SandboxBackend` seam, new routes, 501s | S | Phase 1, no behavior change |
| CH process supervisor (`virtiofsd`, CH, TAP, vsock) | L | The core of phase 2 |
| Rootfs build from the OCI image | M | Replaces `Dockerfile.sandbox` |
| Base snapshot and on-demand restore | M | The density lever |
| nftables and TAP networking | M | Replaces the Docker network |
| Orphan sweep and registry | S | Replaces label-based discovery |
| Browser sandbox type and its tools | M | What started this |
| Snapshot GC | S | TTL, cap, size check |

## Out of scope

Kubernetes, multiple hosts, GPU passthrough, live migration between hosts,
and confidential computing. Cloud Hypervisor supports the last two; we do not
need them yet.
