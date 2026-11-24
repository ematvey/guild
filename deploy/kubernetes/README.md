# Guild Kubernetes experiment

The manifests target the k3d cluster named `guild-agent-experiment`. They use fresh Kubernetes volumes and generated credentials. The Guild application, fetch service, PostgreSQL, ClickHouse, and RustFS run in the `guild-experiment` namespace. Agent Substrate v1.0.1 has its own control plane and a Guild gVisor WorkerPool.

The K3s server uses [k3s-substrate.yaml](k3s-substrate.yaml) under `/etc/rancher/k3s/config.yaml.d/`. Those settings serve the certificate APIs used by the Substrate controller.

From the repository root, build the Guild images and import them into the experiment cluster.

```bash
docker build -f Dockerfile.server-ts -t guild-k8s-server:experiment .
docker build -t guild-k8s-curl-fetch:experiment deploy/curl-fetch
k3d image import -c guild-agent-experiment guild-k8s-server:experiment guild-k8s-curl-fetch:experiment
```

Install the cluster components with the experiment kubeconfig. The second argument to the Substrate installer is a checkout of the upstream v1.0.1 tag.

```bash
experiment_kubeconfig="$(k3d kubeconfig write guild-agent-experiment)"
deploy/kubernetes/install-data.sh "$experiment_kubeconfig"
deploy/kubernetes/install-substrate.sh "$experiment_kubeconfig" /path/to/substrate
kubectl --kubeconfig "$experiment_kubeconfig" apply --server-side -f deploy/kubernetes/worker-pool.yaml
deploy/kubernetes/install-guild.sh "$experiment_kubeconfig"
```

The Guild deployment points the existing sandbox RPC client at `guild-substrate:8090`. The Substrate adapter at that address provisions Actors and bridges the existing authenticated sandbox protocol. The data installer formats JuiceFS and mounts it on the Kubernetes node. The workspace CSI adapter maps each Actor attachment to its assigned directory. The Guild server mounts the JuiceFS root for workspace file access.

The adapter provisions a Substrate egress policy for each Actor. Its default
rules allow TLS on port 443 to Guild's package registry allowlist. Substrate
enforces the policy for Actor traffic and DNS. New Actors use their own
writable home for local package caches and user-level installs.

The sandbox image contains the Actor entry point `node /opt/guild/actor.js`, which serves Guild sandbox RPC at `/rpc` on port 8080. The image smoke test exercises workspace write and read across separate WebSocket connections. Cluster validation also needs Actor placement, mount isolation, and suspend and resume.

```bash
docker build -f Dockerfile.sandbox -t guild-k8s-actor:experiment .
deploy/kubernetes/verify-actor-image.sh
```

The experiment node runs on an overlay-backed container filesystem. Substrate needs an overlay-compatible upper directory for Actor scratch. On this node, mount a bounded tmpfs before installing Substrate. Reapply it after restarting the node and before starting Actors. Substrate snapshots and JuiceFS metadata and objects use Kubernetes storage.

```bash
docker exec k3d-guild-agent-experiment-server-0 mount -t tmpfs -o size=5g,mode=0755 tmpfs /var/lib/ate
```

Publish the local OCI image by digest with `publish-actor-image.sh`. The registry is internal to the experiment cluster and the Substrate development profile resolves its localhost image references to it. The [probe template](actor-probe-template.yaml) runs the exact Guild image on the Guild worker pool and exposes the RPC listener over the authenticated Actor router.

For the cluster RPC probe, publish the image and substitute its immutable
reference into the probe template. The in-cluster probe uses the same
projected identity planned for the Guild execution adapter.

```bash
export KUBECONFIG="$(k3d kubeconfig write guild-agent-experiment)"
actor_image="$(deploy/kubernetes/publish-actor-image.sh "$KUBECONFIG")"
kubectl-ate create atespace guild-experiment
sed "s|\${GUILD_ACTOR_IMAGE}|$actor_image|" deploy/kubernetes/actor-probe-template.yaml |
  kubectl-ate create actor-template -f -
kubectl-ate create actor guild-rpc-probe-v3 -a guild-experiment --template guild-rpc-probe-v2
kubectl -n guild-experiment create configmap guild-actor-router-probe \
  --from-file=router.ts=apps/server/src/sandbox/substrate/router.ts --dry-run=client -o yaml |
  kubectl apply --server-side -f -
kubectl apply --server-side -f deploy/kubernetes/actor-router-probe.yaml
kubectl -n guild-experiment wait --for=condition=Ready pod/guild-actor-router-probe --timeout=60s

marker="$(openssl rand -hex 16)"
kubectl -n guild-experiment exec -i guild-actor-router-probe -- env \
  ACTOR_NAME=guild-rpc-probe-v3 PROBE_PHASE=write PROBE_VALUE="$marker" bun - \
  < deploy/kubernetes/probe-actor-rpc.mjs
kubectl-ate suspend actor guild-rpc-probe-v3 -a guild-experiment
kubectl -n guild-experiment exec -i guild-actor-router-probe -- env \
  ACTOR_NAME=guild-rpc-probe-v3 PROBE_PHASE=read PROBE_VALUE="$marker" bun - \
  < deploy/kubernetes/probe-actor-rpc.mjs
```

The probe writes under the OCI image's user home. It exercises the sandbox
RPC, Actor lifecycle, and restoration of the container filesystem.

## JuiceFS isolation probe

The privileged node DaemonSet mounts JuiceFS once. The workspace CSI bridge
bind-mounts one validated directory under that mount into the Actor-specific
path provided by atelet. Substrate includes that path in the Actor's OCI spec
as `/workspace`. The Actor uses its workspace without receiving object storage
or metadata credentials. The workspace persists independent of Actor deletion.

Build and import the bridge image, then install it on the experiment cluster.

```bash
docker build -t guild-k8s-workspace-csi:experiment deploy/kubernetes/workspace-csi
k3d image import -c guild-agent-experiment guild-k8s-workspace-csi:experiment
kubectl --kubeconfig "$experiment_kubeconfig" apply --server-side -f deploy/kubernetes/workspace-csi.yaml
kubectl --kubeconfig "$experiment_kubeconfig" -n guild-experiment rollout status ds/guild-workspace-csi
```

With the RPC probe pod running and the Actor image published, create two
isolated workspace Actors and check the mount, suspension, and wakeup.

```bash
deploy/kubernetes/create-workspace-probe.sh "$experiment_kubeconfig" "$actor_image" juice-probe-a 00000000-0000-4000-8000-000000000002
deploy/kubernetes/create-workspace-probe.sh "$experiment_kubeconfig" "$actor_image" juice-probe-b 00000000-0000-4000-8000-000000000003
deploy/kubernetes/verify-workspace-isolation.sh "$experiment_kubeconfig"
```

## Guild execution adapter

The adapter runs as one replica in the experiment namespace. It uses a
projected ServiceAccount token to provision Actors in the Guild atespace
and a short-lived workload certificate to open Actor tunnels. It assigns
the Actor and workspace stable names derived from Guild's sandbox key
and workspace path. The adapter suspends an Actor after its last sandbox
connection closes and the idle interval elapses. An incoming connection
wakes it through atenet. An existing Actor keeps its image and snapshot
settings so it can resume with its saved state. Newly created Actors use
the adapter deployment’s image and snapshot settings.

Install the workspace CSI bridge first, then publish the sandbox image and
deploy the execution adapter. The atespace access policy grants the adapter
editor access to the experiment atespace.

```bash
docker build -t guild-k8s-substrate-adapter:experiment deploy/kubernetes/substrate-adapter
k3d image import -c guild-agent-experiment guild-k8s-substrate-adapter:experiment
kubectl --kubeconfig "$experiment_kubeconfig" label namespace guild-experiment ate.dev/api-access=true --overwrite
kubectl-ate --kubeconfig "$experiment_kubeconfig" create access-policy -a guild-experiment -f deploy/kubernetes/substrate-access-policy.yaml
kubectl --kubeconfig "$experiment_kubeconfig" -n guild-experiment create configmap guild-actor-image \
  --from-literal=reference="$actor_image" --dry-run=client -o yaml |
  kubectl --kubeconfig "$experiment_kubeconfig" apply --server-side -f -
kubectl --kubeconfig "$experiment_kubeconfig" apply --server-side -f deploy/kubernetes/substrate-adapter.yaml
kubectl --kubeconfig "$experiment_kubeconfig" -n guild-experiment rollout status deployment/guild-substrate
```

The runner probe invokes Guild's actual RunnerClient from its deployment.
For a fast probe, set the adapter's `GUILD_ACTOR_IDLE` to `3s` and wait for
the rollout before running the probe.

```bash
deploy/kubernetes/verify-substrate-runner.sh "$experiment_kubeconfig"
```

With the router probe ConfigMap installed, run
`verify-worker-replacement.sh KUBECONFIG` to test a durable Actor snapshot.
It creates a disposable worker pool, writes separate markers to the Actor's
local filesystem and JuiceFS, suspends synchronously, and replaces that
pool's worker pod. It checks both markers after resume.

## Default dev verification

Run `verify-default-dev.sh KUBECONFIG GUILD_HTTPS_ORIGIN` to verify the
default cluster's Guild, sandbox adapter and workspace mount.
The default deployment mounts plain-chat workspaces under `GUILD_DATA_DIR/chats`
and Agent workspaces under `GUILD_AGENT_WORKSPACE_ROOT/agents`. The experiment
manifests keep both sandbox workspace types in JuiceFS. The default probe
writes to both workspace types, verifies that only the Guild
pod gets a PostgreSQL protocol response, and exercises a GitHub integration read and
persists an Assistant reply through the configured public origin. It uses a temporary session and chat.
