# Deploy Guild on Kubernetes

The [Guild Helm chart](chart/) installs and upgrades the server, fetch service,
Substrate adapter, Actor workers, JuiceFS and workspace CSI on a cluster with
Agent Substrate already installed. Helm, kubectl, and kubectl-ate are required.
Keep the release name and namespace stable across upgrades.

This reference supports one Guild installation per cluster. The CSI driver
name, workspace host paths, and Actor worker selector are shared within a
cluster. Use a dedicated production cluster, or migrate the existing release
before installing in another namespace on the same cluster. Creating an empty
`guild-prod` namespace alongside dev does not provide that isolation.

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
   CSI (`deploy/kubernetes/workspace-csi`) images. GitHub Actions builds and
   smoke-tests the Actor image from `Dockerfile.sandbox`, pushes it to
   `ghcr.io/ematvey/guild-sandbox`, and attaches a `guild-helm-<commit>` artifact
   with the matching digest already set as the chart default. The package owner
   sets the GHCR package to Public for anonymous pulls.
3. Copy `values.example.yaml`, set the four workload image references and the Substrate
   atespace explicitly, and optionally set
   the ingress host, class, annotations, and TLS Secret. The base app manifests
   expect PostgreSQL, ClickHouse, and RustFS at services named `postgres`,
   `clickhouse`, and `rustfs` in the target namespace. Provision the databases,
   S3 bucket, and formatted JuiceFS filesystem before deploying. To use
   existing services, supply Deployment and DaemonSet overrides for the
   connection settings and any host paths. Use Secret references for credentials.
   The base mounts a `guild-data-dir` PVC at `/data`. Set
   `storage.createDataClaim: false` if your Deployment override supplies it another way.

Organizations can override `images.actor` with their own
`registry/repository@sha256:<digest>` image. The image must run Guild's sandbox
RPC entry point and be pullable by Substrate. For a private registry, configure
Substrate's image pull credentials. Set `images.actor` explicitly when
installing directly from the chart source in the repository. Changing the
digest rolls the adapter, and newly created Actors use the new image.

## Apply and verify

Run from the repository root. Set `KUBECONFIG` to the target cluster's
kubeconfig and verify the context before provisioning resources.

```sh
context=my-production-cluster
namespace=guild-prod
atespace=guild-prod
values=/path/to/guild-prod-values.yaml
chart=/path/to/guild-0.1.0.tgz

helm lint --strict "$chart" -f "$values"
helm template guild "$chart" --namespace "$namespace" -f "$values"
kubectl --context "$context" create namespace "$namespace" --dry-run=client -o yaml |
  kubectl --context "$context" apply -f -
kubectl --context "$context" label namespace "$namespace" ate.dev/api-access=true --overwrite
```

Provide the `guild-server` Secret with the Guild master key, JWT and internal
keys, and sandbox runner token, plus any environment-specific Guild settings.
For the base manifests supply the `guild-data` Secret with `postgres-password`,
`clickhouse-password`, `rustfs-access-key`, and `rustfs-password`. Preserve keys during migration so
Guild retains access to existing encrypted data and sessions. Keep Secret
values outside the deployment settings and rendered manifests.

Create the atespace named in your values with `kubectl-ate --context "$context"
create atespace "$atespace"`, or use an existing atespace during migration. Grant the
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
helm upgrade --install guild "$chart" --kube-context "$context" \
  --namespace "$namespace" -f "$values" --dry-run=server
helm upgrade --install guild "$chart" --kube-context "$context" \
  --namespace "$namespace" -f "$values" --wait --timeout 10m
kubectl --context "$context" -n "$namespace" rollout status daemonset/guild-juicefs daemonset/guild-workspace-csi
kubectl --context "$context" -n "$namespace" get workerpool guild-actor-workers
deploy/kubernetes/verify-default-dev.sh "$KUBECONFIG" https://guild.example.org "$namespace" "$context"
deploy/kubernetes/verify-substrate-runner.sh "$KUBECONFIG" "$namespace" "$atespace" "$context"
```

The worker pool is a Substrate custom resource. Verify its ready replica
count matches `workerReplicas` separately from Helm's rollout wait. Pass the
configured atespace as the third argument to the runner check when it differs
from the namespace. The first verification script runs integration and chat
probes against the configured Guild instance. Use test credentials and an
approved test workspace when running it in production.

To use existing backing services or site-specific node placement, set
`workloadSpecs.<workload-name>` to the complete replacement Kubernetes
`spec`. Keep connection credentials in Secret references. The chart still
sets image references, pull policy, and the adapter's atespace through their
top-level values. The data PVC is retained on Helm uninstall. Store the
release values and referenced Secret provisioning in your cluster's
configuration source of truth.

## One-time namespace migration

Keep the existing atespace in the Helm values to retain Actor and snapshot
identities. Preserve the JuiceFS metadata URL, object storage, workspace host
paths, and data credentials. The Kubernetes namespace and Substrate atespace
have independent lifecycles.

1. Prepare the target namespace, Secrets, and Substrate permissions as above.
   Render the target chart with `helm template` and inspect the manifests.
   Retain the source workload definitions, ingress, and CSI driver endpoint
   for rollback.
2. Stop the source Guild workload, drain sessions, and wait for Actors to
   suspend. Stop the source CSI and JuiceFS DaemonSets before starting target
   replacements because they share host mount paths and sockets. Change the
   cluster-wide `CSIDriverConfig` endpoint to the target service as part of
   this maintenance window. This is an explicit ownership transfer.
3. Install the target release. Review any existing target objects and the
   cluster-scoped CSI config before adopting them with Helm's
   `--take-ownership`. Apply that flag only when the resource list has been
   checked and no other release should manage those objects. Wait for the
   target mounts and workers. Substrate v1.0.1 can retain gRPC connections to
   the old service after the CSI endpoint changes. Roll
   `deployment/ate-api-server` in `ate-system` and wait for it.
4. Switch the ingress, run the workspace, chat, and Actor suspend/resume
   verification, then retire the source workers and repeat the Actor check.
   Remove the source namespace after verification. Retain the atespace, storage
   classes, and backing data.

For rollback, stop the target workloads and mounts, restore the previous CSI
endpoint and roll the Substrate API Deployment. Bring back the source mounts,
workers, app, and ingress. Preserve all storage during the move.
