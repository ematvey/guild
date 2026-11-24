#!/usr/bin/env python3
"""Render and apply Guild workloads to a cluster with Agent Substrate installed."""
import argparse
import json
import re
import subprocess
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
EXPERIMENT = "guild-experiment"
GROUPS = {
    "foundation": ("substrate-adapter.yaml", "workspace-csi.yaml"),
    "mount": ("juicefs-mount.yaml",),
    "csi": ("workspace-csi.yaml",),
    "workers": ("worker-pool.yaml",),
    "app": ("substrate-adapter.yaml", "guild.yaml"),
}


def load(path):
    return list(yaml.safe_load_all(path.read_text()))


def in_group(group, resource):
    kind = resource["kind"]
    if group == "foundation":
        return kind not in {"DaemonSet", "Deployment", "CSIDriverConfig"}
    if group == "csi":
        return kind in {"DaemonSet", "CSIDriverConfig"}
    if group == "app":
        return kind not in {"NetworkPolicy", "ServiceAccount", "ClusterRole",
                            "ClusterRoleBinding", "ValidatingAdmissionPolicy",
                            "ValidatingAdmissionPolicyBinding"}
    return True


def identity(resource):
    return resource["kind"], resource["metadata"]["name"]


def render(args, settings):
    overrides = {}
    for path in args.override:
        for resource in load(path):
            if not resource:
                continue
            key = identity(resource)
            if key in overrides:
                raise SystemExit(f"Duplicate override: {key}")
            if set(resource) != {"kind", "metadata", "spec"} or set(resource["metadata"]) != {"name"}:
                raise SystemExit(f"Override must contain only kind, metadata.name and spec: {key}")
            overrides[key] = resource["spec"]

    seen = set()
    resources = []
    if "foundation" in args.groups:
        resources.extend([
            {"apiVersion": "v1", "kind": "Namespace",
             "metadata": {"name": args.namespace, "labels": {"ate.dev/api-access": "true"}}},
            {"apiVersion": "v1", "kind": "ConfigMap",
             "metadata": {"name": "guild-actor-image", "namespace": args.namespace},
             "data": {"reference": settings["actorImage"]}},
        ])
    for group in args.groups:
        for filename in GROUPS[group]:
            manifest = [resource for resource in load(HERE / filename) if resource]
            if group == "workers":
                manifest.sort(key=lambda resource: resource["kind"] != "NetworkPolicy")
            for resource in manifest:
                if not resource or not in_group(group, resource):
                    continue
                # Namespace substitution happens on the base only. Site values are literal.
                resource = json.loads(json.dumps(resource).replace(EXPERIMENT, args.namespace))
                key = identity(resource)
                if key in seen:
                    continue
                seen.add(key)
                if key in overrides:
                    resource["spec"] = overrides[key]
                if key == ("CSIDriverConfig", "workspace.csi.guild.dev"):
                    resource["spec"]["controllerEndpoint"] = (
                        f"tcp://guild-workspace-csi.{args.namespace}.svc."
                        f"{settings.get('clusterDomain', 'cluster.local')}:50051"
                    )
                if resource["kind"] in {"Deployment", "DaemonSet"}:
                    containers = resource["spec"]["template"]["spec"]["containers"]
                    for container in containers:
                        image = settings["images"].get(container["name"])
                        if image:
                            container["image"] = image
                            container["imagePullPolicy"] = settings.get("imagePullPolicy", "IfNotPresent")
                        elif container["name"] in {"server", "curl-fetch", "adapter", "csi"}:
                            raise SystemExit(f"Image required for {container['name']}")
                        if container["name"] == "adapter":
                            env = container.setdefault("env", [])
                            env[:] = [item for item in env if item["name"] != "GUILD_ATESPACE"]
                            env.append({"name": "GUILD_ATESPACE",
                                        "value": settings.get("atespace", args.namespace)})
                resources.append(resource)
    if settings.get("createDataClaim", True) is False:
        resources = [resource for resource in resources
                     if identity(resource) != ("PersistentVolumeClaim", "guild-data-dir")]
    if "app" in args.groups and (host := settings.get("ingressHost")):
        spec = {
            "rules": [{"host": host, "http": {"paths": [{
                "path": "/", "pathType": "Prefix",
                "backend": {"service": {"name": "guild", "port": {"number": 8080}}},
            }]}}],
        }
        if ingress_class := settings.get("ingressClass"):
            spec["ingressClassName"] = ingress_class
        if tls_secret := settings.get("ingressTlsSecret"):
            spec["tls"] = [{"hosts": [host], "secretName": tls_secret}]
        resources.append({
            "apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
            "metadata": {"name": args.namespace, "namespace": args.namespace,
                         "annotations": settings.get("ingressAnnotations", {})},
            "spec": spec,
        })
    return resources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--kubeconfig", type=Path)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--override", type=Path, action="append", default=[])
    parser.add_argument("--groups", nargs="+", choices=GROUPS, default=list(GROUPS))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--takeover", action="store_true", help="explicitly adopt fields from a prior deployer")
    parser.add_argument("--timeout", default="180s")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?", args.namespace):
        parser.error("namespace must be a Kubernetes DNS label")
    settings = yaml.safe_load(args.config.read_text())
    resources = render(args, settings)
    if not args.apply:
        print(yaml.safe_dump_all(resources, sort_keys=False), end="")
        return
    kube = ["kubectl"]
    if args.kubeconfig:
        kube += ["--kubeconfig", str(args.kubeconfig)]
    kube += ["--context", args.context]
    apply = kube + ["apply", "--server-side", "--field-manager=guild-deploy"]
    if args.takeover:
        apply.append("--force-conflicts")
    for resource in resources:
        # Namespace creation must finish before applying namespaced resources.
        subprocess.run(apply + ["-f", "-"],
                       input=json.dumps(resource), text=True, check=True)
        kind, name = identity(resource)
        if kind in {"Deployment", "DaemonSet"}:
            subprocess.run(kube + ["-n", args.namespace, "rollout", "status",
                                   f"{kind.lower()}/{name}", f"--timeout={args.timeout}"],
                           check=True)
        elif kind == "WorkerPool" and (replicas := resource["spec"]["replicas"]):
            subprocess.run(kube + ["-n", args.namespace, "wait",
                                   f"--for=jsonpath={{.status.readyReplicas}}={replicas}",
                                   f"workerpool/{name}", f"--timeout={args.timeout}"],
                           check=True)


if __name__ == "__main__":
    main()
