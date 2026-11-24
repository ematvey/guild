"""Render one internal MCP service for a Guild connector implementation."""
import argparse
import hashlib
import ipaddress
import json
import re
import uuid
from pathlib import Path

shared_vendors = json.loads((Path(__file__).resolve().parents[2] /
                           "apps/server/src/integrations/shared-mcp-vendors.json").read_text())

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("slug")
parser.add_argument("org", nargs="?", type=uuid.UUID)
parser.add_argument("--tenant-isolated", action="store_true")
parser.add_argument("--shared", action="store_true")
parser.add_argument("--image", default="guild-k8s-server:experiment")
parser.add_argument("--host-gateway-ip", type=ipaddress.ip_address)
parser.add_argument("--issuer", default="https://guild-agent-experiment.invalid")
parser.add_argument("--bundle-sha256")
parser.add_argument("--bundle-version")
parser.add_argument("--impersonated", action="store_true")
parser.add_argument("--legacy-proxy", action="store_true")
args = parser.parse_args()
slug = args.slug
if not re.fullmatch(r"https://[a-zA-Z0-9.-]+", args.issuer):
    parser.error("issuer must be an HTTPS origin")
supported = {
    "atlassian", "firecrawl", "github", "gitlab", "google_workspace",
    "grafana", "hubspot", "langfuse", "posthog", "searxng", "slack",
}
bundle = args.bundle_sha256
if args.shared and (slug not in shared_vendors or args.org is not None or args.tenant_isolated or bundle
                    or args.bundle_version or args.impersonated or args.legacy_proxy):
    parser.error("shared placement requires a supported public vendor")
if args.legacy_proxy:
    if bundle or args.bundle_version or args.impersonated or not args.org:
        parser.error("an envelope proxy requires a connection UUID and org")
    slug = str(uuid.UUID(slug))
elif bundle:
    if slug in supported or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", slug):
        parser.error("invalid registry slug")
    if not re.fullmatch(r"[a-f0-9]{64}", bundle) or not args.bundle_version or not args.tenant_isolated:
        parser.error("registry connectors require an approved SHA-256, version and tenant isolation")
elif slug not in supported:
    raise SystemExit(f"unsupported Guild connector {slug!r}")
elif args.bundle_version or args.impersonated:
    parser.error("bundle options apply only to registry connectors")
impersonated = slug == "google_workspace" or args.impersonated or args.legacy_proxy
name = f"guild-mcp-{slug.replace('_', '-')}"
if bundle:
    name = f"{name[:18].rstrip('-')}-{hashlib.sha256(slug.encode()).hexdigest()[:8]}"
if (args.tenant_isolated or impersonated) and args.org is None:
    parser.error("a tenant UUID is required")
if args.legacy_proxy:
    name = f"guild-mcp-envelope-{slug}"
elif args.tenant_isolated:
    name += "-" + args.org.hex
labels = {"app": name}
env = [{"name": "GUILD_MCP_CONNECTOR", "value": slug}]
if slug == "firecrawl":
    env.append({"name": "GUILD_CURL_FETCH_URL", "value": "http://curl-fetch:8080"})
if bundle:
    env.extend([
        {"name": "GUILD_MCP_BUNDLE_SHA256", "value": bundle},
        {"name": "GUILD_MCP_BUNDLE_VERSION", "value": args.bundle_version},
    ])
if args.shared:
    env.append({"name": "GUILD_MCP_SHARED", "value": "1"})
sources = [] if args.shared else [{"secret": {"name": name + "-settings", "items": [
    {"key": "settings.json", "path": "settings.json"},
]}}]
if impersonated:
    env.extend([
        {"name": "GUILD_MCP_ORG", "value": str(args.org)},
        {"name": "GUILD_MCP_ISSUER", "value": args.issuer},
    ])
    sources.append({"configMap": {"name": "guild-agentgateway-issuer"}})
else:
    sources.append({"secret": {"name": name + "-access", "items": [
        {"key": "Authorization", "path": "access-key"},
    ]}})

def resource(api, kind, spec):
    return {
        "apiVersion": api,
        "kind": kind,
        "metadata": {"name": name, "namespace": "guild-experiment"},
        "spec": spec,
    }

items = [
    resource("v1", "Service", {
        "selector": labels,
        "ports": [{"port": 8080, "appProtocol": "agentgateway.dev/mcp"}],
    }),
    resource("apps/v1", "Deployment", {
        "replicas": 1,
        "selector": {"matchLabels": labels},
        "template": {
            "metadata": {"labels": labels},
            "spec": {
                "automountServiceAccountToken": False,
                **({"hostAliases": [{"ip": str(args.host_gateway_ip), "hostnames": ["host.docker.internal"]}]}
                   if slug == "firecrawl" and args.host_gateway_ip else {}),
                "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "fsGroup": 1000},
                "containers": [{
                    "name": "mcp",
                    "image": f"guild-k8s-mcp-bundle:{bundle}" if bundle else args.image,
                    "imagePullPolicy": "Never",
                    "command": ["bun", "src/legacy-mcp-proxy.ts" if args.legacy_proxy else "src/connector-mcp.ts"],
                    "env": env,
                    "ports": [{"containerPort": 8080}],
                    "readinessProbe": {"httpGet": {"path": "/healthz", "port": 8080}},
                    "volumeMounts": [{"name": "connector", "mountPath": "/run/guild-mcp", "readOnly": True}],
                }],
                "volumes": [{
                    "name": "connector",
                    "projected": {"defaultMode": 0o440, "sources": sources},
                }],
            },
        },
    }),
    resource("networking.k8s.io/v1", "NetworkPolicy", {
        "podSelector": {"matchLabels": labels},
        "policyTypes": ["Ingress"],
        "ingress": [{
            "from": [{"podSelector": {"matchLabels": {
                "gateway.networking.k8s.io/gateway-name": "guild-ai",
            }}}],
            "ports": [{"port": 8080}],
        }],
    }),
]
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))
