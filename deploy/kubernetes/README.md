# Guild Kubernetes experiment

The manifests target the k3d cluster named `guild-agent-experiment`. They use fresh Kubernetes volumes and generated credentials. The Guild application, fetch service, PostgreSQL, ClickHouse, and RustFS run in the `guild-experiment` namespace. The internal AI gateway uses agentgateway v1.7.0. Agent Substrate v1.0.1 has its own control plane and a Guild gVisor WorkerPool.

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
deploy/kubernetes/install-agentgateway.sh "$experiment_kubeconfig"
kubectl --kubeconfig "$experiment_kubeconfig" apply --server-side -f deploy/kubernetes/gateway.yaml
deploy/kubernetes/install-gateway-identity.sh "$experiment_kubeconfig"
deploy/kubernetes/install-substrate.sh "$experiment_kubeconfig" /path/to/substrate
kubectl --kubeconfig "$experiment_kubeconfig" apply --server-side -f deploy/kubernetes/worker-pool.yaml
deploy/kubernetes/install-guild.sh "$experiment_kubeconfig"
```

The Guild deployment points the existing sandbox RPC client at `guild-substrate:8090`. The Substrate adapter at that address provisions Actors and bridges the existing authenticated sandbox protocol. The data installer formats JuiceFS and mounts it on the Kubernetes node. The workspace CSI adapter maps each Actor attachment to its assigned directory. The Guild server mounts the JuiceFS root for workspace file access. The model path uses agentgateway with signed organization and model claims. Guild turns and the member tool API discover and execute external tools via the org MCP route. Agentgateway applies the tool policy to discovery and execution.

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
wakes it through atenet.

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
default cluster's Guild, sandbox adapter, gateway, and workspace mount.
The probe writes to both workspace types, verifies that only the Guild
pod gets a PostgreSQL protocol response, and exercises a GitHub gateway read and
persists an Assistant reply through the configured public origin. It uses a temporary session and chat.

## Gateway fixtures

Guild forks Pi Durable workers inside the Guild server pod. Substrate
Actors run shell and file tools on demand with the JuiceFS workspace
mounted and receive no Guild database credentials or PostgreSQL egress.

The model fixture runs deterministic OpenAI and Anthropic streams. Its
renderer takes the experiment org UUID and creates model-specific routes,
upstream provider configuration, and authorization policies. Guild derives
the model route ID from the first 32 hex digits of the model ID's SHA-256
digest. The fixture upstream requires the agentgateway provider key, and the
probe checks that missing credentials and mismatched org and model claims
are denied by agentgateway. The Guild model catalog retains model metadata
and usage settings while model requests use the gateway route.

The MCP fixture advertises two tools. The gateway MCP policy filters the
denied tool from the list and rejects a direct call. The fixture requires
its own upstream key. Both verification scripts use the Guild cluster
deployment and are intended only for the synthetic experiment backends.

## Connector services

The external connector host exposes Guild's existing compiled vendor tools
over Streamable HTTP. Render one internal service for a connector with
`render-connector.py SLUG`. The service reads vendor settings from its `-settings` Secret. Ordinary
connectors accept the token from their separate `-access` Secret, injected
by the agentgateway target. Use `--tenant-isolated` with an org UUID to give
each org an independent service and credential references. Google Workspace
validates a short-lived signed identity token from its own gateway target
and uses the signed acting identity for the vendor exchange.
Use `prefixMode: Always` so the registry's tool names remain stable as targets
are added. The synthetic SearXNG target models these Kubernetes resources
without requiring a live vendor account.

Run `verify-vendor-discovery.sh KUBECONFIG` to deploy all eleven compiled
vendor connectors temporarily and check the tool inventory through
agentgateway. The probe uses synthetic settings and exercises discovery and
tool filtering. It also calls the ten non-delegated connectors against the
deployed fixture, which checks their request parameters and required
credentials. The separate Google Workspace probe covers delegated access.
Stripe already uses a hosted MCP endpoint. The legacy migration fixture uses
Stripe's real header templates with a synthetic upstream to check bearer
authentication and connected-account scoping.

The signed-in chat probe exercises the member tool API, a model-driven MCP
tool call, and the thread journal. With `PROBE_WORKSPACE=1` it also writes and
reads a file inside the Actor and downloads the same file through Guild.
With `PROBE_SEARXNG=1` it exercises the deployed SearXNG connector and the
structured metadata returned over MCP.

Run `verify-chat-restart.sh KUBECONFIG` with the model and MCP fixtures
installed to replace the experiment Guild pod. The probe creates a synthetic
chat, runs a model-driven MCP tool and writes a workspace file. It then
confirms the transcript and file remain readable while the Actor is suspended.
Pass `--postgres` to replace the single PostgreSQL pod too and verify that
its persistent volume claim is reused and the Guild server stays running.
Guild requests may fail briefly while PostgreSQL is unavailable.

Render an organization route with `render-org-mcp.py inventory.json`. Give
each target an explicit tool allowlist and optional member UUIDs. An
optional `chats` array restricts a target to signed Guild chat UUIDs.
Agentgateway
excludes member-specific targets before contacting them and applies tool
authorization at discovery and execution. [The personal fixture](fixtures/personal-mcp.json)
exercises a shared target alongside a member-specific target.
Run `verify-gateway-policy-reload.sh KUBECONFIG` to revoke a member's
personal tool during a live MCP session and check that a fresh connection
still has the shared tool. Backend inventory changes can invalidate an
existing MCP session. Guild opens a new peer when executing each gateway tool.

The Google Workspace fixture uses a synthetic service account and checks
the expected delegated member at the token endpoint. With
`PROBE_GOOGLE=1`, the signed-in chat probe confirms the binary result reaches
JuiceFS and is available for download through the Guild file API.

## Import legacy connections

Use `migrate-org-mcp.sh KUBECONFIG PLAN_JSON` to migrate selected
connections from the experiment Guild database to agentgateway. The plan
names the org UUID and each target's source (`org` or `personal`), legacy
row UUID, DNS-label target name, and explicit tool allowlist. Personal targets
require their owner UUID. Org targets require a member UUID allowlist.
Either kind can include a `chats` allowlist of Guild chat UUIDs.

The importer reads encrypted credentials using the Guild server's existing
store code, transfers them through private temporary files into Kubernetes
Secrets, and deploys tenant-specific MCP services for compiled vendors. It
uses the agentgateway route renderer for remote MCP targets and credential
header injection. Legacy rows remain available for rollback and export.
For a remote org plugin configured with Guild's identity envelope, set
`identityEnvelope: true` on its plan entry. The importer deploys an internal
MCP proxy that validates the signed org and member claims and sends the
legacy headers and connector credentials to the configured upstream.
The upstream receives a fresh call ID for each HTTP request. Guild's
gateway bearer token stays inside the cluster.

### Shared MCP endpoint

The internal gateway serves one MCP URL per org at `/mcp/<org-id>`. Guild
and service consumers use the same URL. Guild signs workload tokens.
Agentgateway authorizes target discovery and tool calls. Substrate uses
its own networking gateway. Set `GUILD_AGENTGATEWAY_MCP_ONLY=1` to route
Guild MCP through agentgateway while keeping the configured model providers.
Set `GUILD_AGENTGATEWAY_MCP_SLUGS` to the comma-separated integration slugs
approved for selective cutover. Guild uses local integration policy for
both paths and starts a selected connector only through agentgateway.
Personal MCP connections continue through their existing path in this mode.

Set `GUILD_AGENTGATEWAY_SERVICE_TOKENS_ONLY=1` to enable the service token
exchange while Guild uses its configured providers and direct integrations.
Point `GUILD_MCP_SERVICES_FILE` at a private JSON array of entries with
`id`, `org`, `secretSha256`, and optional `allowDelegation`. Give each
service a unique random secret and put its SHA-256 in the file. Restart
Guild after replacing the file. Service callers POST to
`/api/v1/mcp/service-token` with `X-Guild-MCP-Service` and
`X-Guild-MCP-Service-Key`. For delegated calls, the user supplies a
Guild session bearer token in `Authorization`. Guild verifies membership
in the service's org and derives the acting identity from the session.
The response contains the MCP URL and a bearer authorization valid for
90 seconds. Use confidential transport for both requests.

The import plan describes the org's complete published MCP inventory.
Run `fixtures/plan-current-mcp-inventory.mjs` inside Guild with
`PROBE_ORG_ID` to derive a draft from direct discovery, audiences, tool
classes, and curation. It reads no credential values into the plan and
grants no access to consuming services. The `memberTools` map records
each member's precise tool subset.
A target can name `services` with entries containing `id`, `tools`,
and optional `delegatedMembers`. Service tools must be a subset of the
target tools. Omit `delegatedMembers` for headless access. Personal,
impersonated, and identity-envelope targets require explicit delegated
members. Chat-scoped targets accept Guild chat callers.

Set `placement` to `shared` for the public GitHub, HubSpot, or Slack API.
The vendor Deployment uses a fixed public upstream and agentgateway
injects the target's credential per request. The connector's Secret
contains its gateway access key. Each vendor credential stays in its own
target Secret. Tenant placement is the default for compiled connectors.
Use it for custom API URLs, delegated connectors, and registry bundles.

To publish on default dev, pass `--default-dev` to the importer with
`GUILD_MCP_CONNECTOR_IMAGE` set to the installed Guild server image and
`GUILD_AGENTGATEWAY_ISSUER` set to the configured token issuer. Set `GUILD_MCP_HOST_GATEWAY_IP` when
the Firecrawl connection uses the host-side Docker address.
For credential-only changes on an existing tenant connector, add
`--refresh-tenant SLUG` to the importer. It verifies the published target,
updates only that connector's settings, and keeps the gateway transport
key and tool grants in place. A configuration change requires a reviewed
inventory publication.
`verify-mcp-service-grants.sh` and `verify-shared-mcp-connector.sh` exercise the
experiment gateway with temporary routes. Validate vendor and authorization
parity for the actual org inventory before switching Guild's execution.
Feed `fixtures/verify-mcp-parity.mjs` to `bun -` inside Guild with
`PROBE_MEMBER_ID` set to an intended caller. It compares the direct and
published tools after Guild applies the member's scope, including input
schemas, classes, traits, delegation, and approval settings. Set
`PROBE_EXECUTE_READS=1` to run one read-only operation per target. Set
`PROBE_BASELINE_ONLY=1` to measure the direct inventory before publishing.

### Registry code bundles

Use `import-mcp-bundle.sh ARCHIVE APPROVED_SHA256` to package an approved
registry archive in a separate OCI image and import it into the experiment
cluster. The MCP service verifies the approved hash, slug and version before
running the bundle. The service receives only its connector's Kubernetes
Secrets and has no mounted service account token.

Render the tenant-specific service with
`render-connector.py SLUG ORG --tenant-isolated --bundle-sha256 APPROVED_SHA256 --bundle-version VERSION`.
Create the settings and access Secrets named in the rendered deployment,
then add the internal Service URL, member allowlist and approved tool names to
the org MCP inventory. For an impersonated bundle, use `--impersonated` and
set `delegatesActingIdentity` and `delegatedConnectorSlug` on that internal
target. Registry bundles are onboarded individually with their approved
archive and settings.

In gateway mode, Guild's integration settings show a read-only inventory of
tools available to the signed-in admin. Legacy configuration and probe
requests return `integration_managed_by_agentgateway`. The member inventory
and tool execution APIs also use the gateway-backed configuration.

Run the server suite with `test-server.sh KUBECONFIG` after installing the
server workspace dependencies and building the desktop web bundle. Set
`GUILD_TEST_SUBSTRATE=1` to exercise the deployed Actor adapter in the
sandbox integration suites. Test stacks create disposable Postgres
databases and S3 buckets. The script uses loopback forwards to the
experiment cluster's services.
