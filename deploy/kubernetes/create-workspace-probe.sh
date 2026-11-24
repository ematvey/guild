#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: create-workspace-probe.sh KUBECONFIG ACTOR_IMAGE ACTOR_NAME AGENT_ID}"
actor_image="${2:?provide a digest-pinned image reference}"
actor_name="${3:?provide an Actor name}"
agent_id="${4:?provide an Agent UUID}"
worker_label="${5:-sandbox}"
[[ "$actor_image" =~ ^localhost:5000/guild-sandbox@sha256:[a-f0-9]{64}$ ]]
[[ "$actor_name" =~ ^[a-z0-9]([a-z0-9-]{0,45}[a-z0-9])?$ ]]
[[ "$agent_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]
[[ "$worker_label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
[[ "$context" == k3d-guild-agent-experiment ]]

kubectl --kubeconfig "$kubeconfig" apply --server-side -f - <<YAML
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: guild-$actor_name
provisioner: workspace.csi.guild.dev
parameters:
  workspaceKey: agents/00000000-0000-4000-8000-000000000001/$agent_id
reclaimPolicy: Retain
YAML

ate=(kubectl-ate --kubeconfig "$kubeconfig" --preview)
"${ate[@]}" create actor-template -f - <<YAML
metadata:
  atespace: guild-experiment
  name: $actor_name
workerSelector:
  matchLabels:
    guild.dev/workload: $worker_label
containers:
  - name: sandbox
    image: $actor_image
    command: [/usr/local/bin/node, /opt/guild/actor.js]
    wakeupProbe:
      httpGet:
        path: /readyz
        port: 8080
    volumeMounts:
      - name: workspace
        mountPath: /workspace
volumes:
  - name: workspace
    external:
      template:
        storageClassName: guild-$actor_name
        capacityBytes: "1073741824"
resources:
  limits:
    cpuMillicores: 500
    memoryBytes: 536870912
snapshotConfig:
  preferredFidelity: SNAPSHOT_FIDELITY_MEMORY
YAML
"${ate[@]}" create actor "$actor_name" -a guild-experiment --template "$actor_name"
