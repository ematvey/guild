# MicroVM sandboxes: options for Guild

Status: investigation, not a decision. Written 2026-11-11, after a
headless-Chromium render hung for 21 minutes inside a gVisor sandbox.

## Why the question came up

A sandboxed `agent_bash` call ran headless Chromium to screenshot a page. It
never returned: on `about:blank` it hangs the same way, and `--single-process`
dies with `FATAL:check.cc NOTREACHED`. The binary was a Lambda build of
Chromium the agent had fetched from npm. So the sandbox can hold a browser,
but the user-space kernel under it cannot run one.

A microVM runs a real Linux kernel. That is the whole argument for moving.

## What the host offers

| Fact | Value |
|---|---|
| Virtualization | `/dev/kvm`, AMD SVM, bare metal (`systemd-detect-virt`: none) |
| CPU / RAM | 48 cores / 251 GB (208 GB in use by the LLM and the stacks) |
| Free disk | 2.0 TB on `/data` |
| Runtime today | Docker + `runsc` (gVisor), one container per (project, key) |

Nested virtualization is available, so a microVM runtime can be adopted on
this host without new hardware.

## What the sandbox must keep

These are the constraints any replacement has to satisfy. They come from
`apps/server/src/sandbox/`.

1. **A workspace volume per sandbox.** `/workspace` is a subpath of a
   JuiceFS volume, mounted by the Docker daemon. The agent's files outlive
   the container.
2. **A small control surface.** The runner serves about ten HTTP routes
   (`/v1/sandboxes`, exec, files, stop, remove) and bridges RPC WebSockets
   to the agent process inside. The server only speaks that API.
3. **Egress through one proxy.** Sandboxes sit on an internal network with
   no gateway; `HTTP(S)_PROXY` points at squid on a fixed IP.
4. **Resource caps.** Memory, CPU, pids, tmpfs sizes, read-only rootfs,
   `cap-drop ALL`, `no-new-privileges`, uid 1000.
5. **Always-on agent sandboxes.** They are exempt from idle reaping today.
6. **A real kernel.** Chromium, and anything else that calls unusual
   syscalls.

## Candidates

### 1. Kata Containers, as a Docker runtime

Kata is an OCI runtime that starts a VM per container. Docker selects it
with `--runtime=`, so the runner, the workspace volume, the egress proxy and
the exec protocol stay as they are. Only `GUILD_SANDBOX_RUNTIME` changes.

- Hypervisors: QEMU, Cloud Hypervisor, Firecracker, Dragonball. The QEMU
  runtime with virtio-fs (`kata-qemu-virtiofs`) shares a host directory into
  the guest, which is how the JuiceFS subpath reaches `/workspace`.
- Chromium: runs, because the guest kernel is real.
- Boot: roughly 0.3–1 s per sandbox, against ~50 ms for `runsc`.
- Cost: one VM per sandbox, ~100–200 MB of guest memory each.
- Pause/resume: no. Kata does not support `docker pause`; stop/start works.
- Snapshot: VM templating exists, snapshotting does not reach us through
  the Docker API.

Fit: **highest, as a first step.** One config value, no code change, and it
answers the Chromium question immediately.

### 2. microsandbox, as a runner replacement

An open-source (Apache 2.0) local-first microVM runtime: Rust core, SDKs for
TypeScript, Rust, Python and Go, OCI images, KVM on Linux.

- Bind mounts: a host directory mounts into the guest, with `readonly` and
  `noexec` options. Same model as our workspace subpath.
- Snapshots: disk, and full (memory plus running processes). A full restore
  **resumes execution**; `cowMemory()` shares unchanged pages between
  children. That is the pause/resume the runner lacks.
- Fork: a live sandbox can be duplicated.
- Boot: sub-100 ms claimed.
- Network: per-sandbox allow lists, private-network blocking.
- Maturity: the project calls itself beta, and expects breaking changes.
- No daemon: the SDK starts the VM in-process. Our runner would become a
  thin adapter over the SDK instead of a Docker client.

Fit: **strong second step.** It is the only candidate that gives snapshot,
restore and fork, and its mount model matches ours. It is also the largest
change: the runner's Docker layer goes away, and a beta dependency enters the
critical path.

### 3. Firecracker, directly

The VMM behind Lambda. Small, fast, mature, with jailer-based containment
and snapshot/restore over a REST API.

- Devices: VirtIO net, block and vsock only (`docs/design.md`). **There is
  no virtio-fs.** The workspace volume cannot be shared into the guest; it
  would have to become a block device or move to a network filesystem.
- Networking: TAP devices are ours to build.
- Orchestration: ours to build — pooling, jailer configs, cgroups, snapshots,
  metrics.

Fit: **poor for us right now.** The storage model conflicts with the JuiceFS
volume, and the orchestration work is exactly what Kata and microsandbox
already do.

### 4. Cloud Hypervisor, directly

virtio-fs and snapshot/restore, in Rust. Same verdict as Firecracker but
without the storage conflict — and with the same orchestration cost. It is
what Kata and microsandbox use underneath.

Fit: **only as a base for our own runtime.** Not worth it while a maintained
layer exists.

### 5. E2B, self-hosted

Firecracker-based, open source, but deployed as a Kubernetes cluster with an
orchestrator and its own storage layer. Our host runs compose, not k8s, and
our workspace is a FUSE volume.

Fit: **no.** The infrastructure it assumes is bigger than the problem.

### 6. Docker Sandboxes (`sbx`)

New (GA 2026), and real: local microVM sandboxes with virtio-fs workspace
passthrough, a host-side proxy that enforces network policy, credential
injection, and per-sandbox Docker state.

- Local sandboxes are a CLI for developer machines, with sign-in.
- The API and SDK are for **cloud** sandboxes only, billed per use.

Fit: **no, but watch it.** It is the closest thing to a productised version
of what we are building, and its isolation and proxy model are worth copying.

### 7. Managed clouds

E2B Cloud, Modal, Daytona, Vercel Sandbox, Cloudflare Sandbox. Fast, no
operations, and every byte of Acme data leaves this host. Our model
serving is local; the sandboxes would not be.

Fit: **no.**

## The control questions, answered per option

| Question | Kata (Docker runtime) | microsandbox | Firecracker direct |
|---|---|---|---|
| Who sets network policy | squid, unchanged | per-sandbox allow list | our own TAP + proxy |
| Workspace mount | virtio-fs of the JuiceFS path | bind mount of the same path | block device or network FS |
| Resource caps | Docker flags, per VM | SDK options, per VM | jailer cgroups |
| Pause / resume | no | yes (full snapshot restore) | yes (snapshot API) |
| Snapshot artifacts | none | **new garbage class** | new garbage class |

## Garbage collection in a microVM world

The container model has four collection points today: image, container
(idle stop, idle remove), process (kill on abort, timeout, wire close), and
workspace (the volume). A microVM adds two.

1. **Base image**: one shared read-only image per project, plus a CoW layer
   per sandbox. Collection is the image cache, not the sandbox.
2. **Snapshots**: a full snapshot is a memory dump plus a disk delta — tens
   to hundreds of MB each. They need a TTL, a per-agent count cap, and a
   dedupe rule. This is the one new way to fill `/data`.
3. **VMs**: the same idle stop and idle remove policy, keyed by VM instead
   of container.
4. **Browser**: bake it into the base image once. Never install it per
   sandbox, never let it write to the workspace; profile on tmpfs.

## Recommendation

1. **This week**: run the dev stack with `GUILD_SANDBOX_RUNTIME=kata-runtime`
   and `kata-qemu-virtiofs`. Measure three things: a Chromium render, boot
   time per sandbox, and JuiceFS read throughput through virtio-fs. No code
   change is needed to try it.
2. **If the numbers hold**: keep Kata for the browser case, and evaluate
   microsandbox behind the same runner API for snapshot and fork. Its bind
   mounts, `noexec`, and CoW memory map onto what we already do.
3. **Do not** build on Firecracker directly until the workspace storage
   question is answered: it has no virtio-fs.

Open questions to settle before a decision:

- Does a Kata sandbox keep the read-only rootfs and `cap-drop ALL` model, or
  does the VM boundary replace them?
- What does a virtio-fs hop cost for the many-small-files pattern our agents
  produce (`rg`, `npm i`, `git status`)?
- Does an always-on agent sandbox at 32 VMs fit in the 42 GB of available
  RAM, at ~150 MB each? Yes, with room — but the LLM already holds 208 GB of
  the 251 GB.
