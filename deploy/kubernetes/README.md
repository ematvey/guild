# Deploy Guild on Kubernetes

Use `deploy.py` on a Kubernetes cluster with Agent Substrate already installed.
The deployer takes an explicit Kubernetes context and namespace, renders the
checked-in manifests, and applies them with a dedicated field manager. Running
it twice with the same settings does not recreate the workspace or rotate
credentials. Python 3, PyYAML, kubectl, and kubectl-ate are required.

## Prepare the cluster and images

1. Install Agent Substrate v1.0.1 with ExternalVolumes enabled, its pod identity
   and trust-bundle controllers, and the gVisor sandbox class. The cluster needs
   support for the projected certificate and trust bundle used by the adapter,
   ValidatingAdmissionPolicy, privileged DaemonSets, FUSE, and bidirectional
   mount propagation. The checked-in policies expect the control plane in
   `ate-system` and CoreDNS in `kube-system`. Arrange node placement so Guild
   and the Actor workers run on nodes with the JuiceFS and CSI DaemonSets.
2. Build and publish the server (`Dockerfile.server-ts`), web fetch
   (`deploy/curl-fetch`), adapter (`deploy/kubernetes/substrate-adapter`), and
   CSI (`deploy/kubernetes/workspace-csi`) images. For the sandbox image, use
   the Actor image build/publish flow below. Make the images accessible to both
   Kubernetes and the Substrate workers. Use immutable image references.
3. Copy `settings.example.yaml`, set the image references and optionally set
   the ingress host, class, annotations, and TLS Secret. The base app manifests
   expect PostgreSQL, ClickHouse, and RustFS at services named `postgres`,
   `clickhouse`, and `rustfs` in the target namespace. Provision the databases,
   S3 bucket, and formatted JuiceFS filesystem before deploying. To use
   existing services, supply Deployment and DaemonSet overrides for the
   connection settings and any host paths. Use Secret references for credentials.
   The base mounts a `guild-data-dir` PVC at `/data`. Set
   `createDataClaim: false` if your Deployment override supplies it another way.

## Apply and verify

Run from the repository root in Bash. Set `KUBECONFIG` to your kubeconfig
file. Use `--kubeconfig PATH` on the deployer to select a different file.

```sh
context=my-cluster
namespace=guild-dev
settings=/path/to/guild-dev.yaml
deploy=(deploy/kubernetes/deploy.py --context "$context" --namespace "$namespace" --config "$settings")

"${deploy[@]}" > /tmp/guild-rendered.yaml
"${deploy[@]}" --groups foundation --apply
```

Provide the `guild-server` Secret with the Guild master key, JWT and internal
keys, and sandbox runner token, plus any environment-specific Guild settings.
For the base manifests supply the `guild-data` Secret with `postgres-password`,
`clickhouse-password`, and `rustfs-password`. Preserve keys during migration so
Guild retains access to existing encrypted data and sessions. Keep Secret
values outside the deployment settings and rendered manifests.

Create the atespace once using `kubectl-ate --context "$context" create atespace
"$namespace"`, or select an existing atespace in the settings. Grant the
principal `user:system:serviceaccount:<namespace>:guild-substrate` the editor role
in its access policy. Use the `substrate-access-policy.yaml` example with the
target namespace in the principal. For an existing policy, read its current
version and add the member with `kubectl-ate update access-policy`, preserving
the other members. Include that service account SPIFFE ID in the Substrate
router's ingress allowlist when the installed routing policy requires it.
For a router configured through `atenet-router-agentgateway-config`, update the
existing `source.spiffeId` allowlist in that ConfigMap and roll
`deployment/atenet-router` in `ate-system`. Preserve other tenants' identities.
Make the same change in the cluster's source of truth if it manages the router.

```sh
"${deploy[@]}" --apply
deploy/kubernetes/verify-default-dev.sh "$KUBECONFIG" https://guild-dev.example.org "$namespace" "$context"
deploy/kubernetes/verify-substrate-runner.sh "$KUBECONFIG" "$namespace" "$namespace" "$context"
```

Pass the configured atespace as the third argument to the runner check when it
differs from the namespace. The deployer waits for storage DaemonSets, the
worker pool, and app rollouts. Use `--groups foundation mount csi workers app`
to select phases and `--override PATH` to supply a YAML document per resource
with only `kind`, `metadata.name`, and the complete replacement `spec`. Omit
`--apply` to inspect changes. Use `--takeover` only after reviewing field
conflicts during an intentional ownership transfer.

## Move an existing deployment

Keep the existing atespace in the settings to retain Actor and snapshot
identities. The Kubernetes namespace and the Substrate atespace are independent.
Keep the existing JuiceFS metadata URL, object storage, workspace host paths,
and data credentials. The CSI driver is cluster-scoped and the supplied driver
name supports one active Guild installation per cluster.

1. Apply the target foundation, transfer the required Secrets securely,
   update Substrate access for the new service account, and bring up the
   target worker pool.
2. Stop Guild and wait for in-flight sessions to drain and Actors to suspend.
   Stop the source CSI and JuiceFS DaemonSets before starting their target
   replacements. They share host mount paths and sockets. Retain the source
   definitions for rollback. Apply `--groups mount csi` in the target.
3. Confirm the CSI controller points at the target service and is ready.
   Substrate v1.0.1 may retain gRPC connections to the old CSI service. After
   changing that endpoint, roll the Substrate API Deployment and wait for its
   replicas before testing new workspace operations:
   `kubectl --context "$context" -n ate-system rollout restart deployment/ate-api-server`
   followed by `kubectl --context "$context" -n ate-system rollout status deployment/ate-api-server`.
   Then apply the target app, switch the ingress, and run the workspace,
   chat, and Actor suspend/resume verification. A host/path can only be
   owned by one ingress on controllers that enforce uniqueness.
4. Scale the source workers to zero and repeat the Actor check against the
   target workers. Only after verification, remove the old namespace. Keep
   the atespace, storage classes, and their backing data.

For rollback, stop the target app and storage DaemonSets, restore the previous
CSI controller endpoint and roll the Substrate API Deployment, bring back the source mounts and workers, and restore
the previous app and ingress. Avoid formatting or deleting any storage during
a namespace move.

## Local k3d experiment

The remaining instructions cover the original disposable k3d setup.

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
