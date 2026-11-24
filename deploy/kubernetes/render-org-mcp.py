"""Render an org's agentgateway MCP inventory from a JSON operations file."""
import argparse
import hashlib
import json
import re
import uuid
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("inventory", type=argparse.FileType("r"))
args = parser.parse_args()
inventory = json.load(args.inventory)
org = str(uuid.UUID(inventory["org"]))
namespace = "guild-experiment"
backend = f"guild-mcp-{org}"
label = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
hostname = re.compile(r"^(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$")
tool_name = re.compile(r"^[A-Za-z0-9_-]+$")
secret_key = re.compile(r"^[A-Za-z0-9_.-]+$")
header_name = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
secret_name_pattern = re.compile(r"^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$")
seen = set()
targets, rules = [], []
entries = inventory["targets"]

def new_resource(api, kind, name, spec):
    return {
        "apiVersion": api,
        "kind": kind,
        "metadata": {"name": name, "namespace": namespace},
        "spec": spec,
    }

for entry in entries:
    name = entry["name"]
    if not label.fullmatch(name) or name in seen:
        raise SystemExit(f"invalid or duplicate MCP target: {name!r}")
    seen.add(name)
    address = urlsplit(entry["url"])
    if (
        address.scheme not in ("http", "https") or not address.hostname
        or not hostname.fullmatch(address.hostname) or address.username is not None
        or address.query or address.fragment
    ):
        raise SystemExit(f"invalid MCP endpoint for {name!r}")
    if address.scheme == "http" and not address.hostname.endswith(".svc.cluster.local"):
        raise SystemExit("plaintext MCP endpoints must be Kubernetes Services")
    static = {
        "host": address.hostname,
        "port": address.port or (443 if address.scheme == "https" else 80),
        "path": address.path or "/mcp",
        "protocol": entry.get("protocol", "StreamableHTTP"),
    }
    if static["protocol"] not in ("StreamableHTTP", "SSE"):
        raise SystemExit(f"unsupported MCP transport for {name!r}")
    policies = {}
    if address.scheme == "https":
        policies["tls"] = {"sni": address.hostname}
    secret = entry.get("credentialSecret")
    if entry.get("legacyEnvelopeProxy") is not None:
        proxy = str(uuid.UUID(entry["legacyEnvelopeProxy"]))
        proxy_host = f"guild-mcp-envelope-{proxy}.{namespace}.svc.cluster.local"
        if (address.scheme != "http" or address.hostname != proxy_host or address.port != 8080
            or static["path"] != "/mcp" or static["protocol"] != "StreamableHTTP"
            or secret is not None or entry.get("credentialHeaders")):
            raise SystemExit("legacy identity requires a dedicated internal envelope proxy")
        policies["auth"] = {"passthrough": {}}
    elif entry.get("delegatesActingIdentity") is True:
        slug = entry.get("delegatedConnectorSlug", "google_workspace")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", slug):
            raise SystemExit("invalid delegated connector slug")
        service = f"guild-mcp-{slug.replace('_', '-')}"
        if slug != "google_workspace":
            service = f"{service[:18].rstrip('-')}-{hashlib.sha256(slug.encode()).hexdigest()[:8]}"
        elif name != "google-workspace":
            raise SystemExit("invalid Google Workspace target name")
        connector_host = f"{service}-{uuid.UUID(org).hex}.{namespace}.svc.cluster.local"
        if (address.scheme != "http" or address.hostname != connector_host
            or address.port != 8080 or static["path"] != "/mcp" or static["protocol"] != "StreamableHTTP"):
            raise SystemExit("delegated identity requires the org's internal connector")
        if secret is not None:
            raise SystemExit("choose a credential Secret or delegated identity")
        policies["auth"] = {"passthrough": {}}
    if secret is not None:
        if not secret_name_pattern.fullmatch(secret):
            raise SystemExit(f"invalid credential Secret name for {name!r}")
        policies["auth"] = {"secretRef": {"name": secret}}
    credentials = []
    for credential in entry.get("credentialHeaders", []):
        header, secret_name, key = (credential[item] for item in ("header", "secret", "key"))
        if (not header_name.fullmatch(header) or not secret_name_pattern.fullmatch(secret_name) or not secret_key.fullmatch(key)
            or header.lower() in ("host", "connection", "content-length", "content-type", "accept", "mcp-session-id")
            or header.lower().startswith("x-guild-")):
            raise SystemExit(f"invalid upstream credential header for {name!r}")
        if header.lower() == "authorization" and policies.get("auth"):
            raise SystemExit(f"duplicate upstream authorization configuration for {name!r}")
        credentials.append({
            "secretRef": {"name": secret_name, "key": key},
            "location": {"header": {"name": header}},
        })
    if credentials:
        policies.setdefault("auth", {})["credentials"] = credentials
    if policies:
        static["policies"] = policies
    target = {"name": name, "static": static}
    member_ids = entry.get("members")
    conditions = []
    if member_ids is not None:
        conditions.append("jwt.sub in " + json.dumps(sorted({str(uuid.UUID(member)) for member in member_ids})))
    if entry.get("chats") is not None:
        chat_ids = sorted({str(uuid.UUID(chat)) for chat in entry["chats"]})
        conditions.append("has(jwt.chat) && jwt.chat in " + json.dumps(chat_ids))
    check = " && ".join(conditions) or "true"
    if conditions and len(entries) > 1:
        target["condition"] = check
    targets.append(target)
    tools = entry["tools"]
    if not tools or not all(tool_name.fullmatch(tool) for tool in tools):
        raise SystemExit(f"an explicit MCP tool allowlist is required for {name!r}")
    rules.append(
        f"mcp.tool.target == {json.dumps(name)} && ({check}) && mcp.tool.name in {json.dumps(sorted(set(tools)))}"
    )

if not targets:
    raise SystemExit("at least one MCP target is required")

api = "agentgateway.dev/v1alpha1"
route_api = "gateway.networking.k8s.io/v1"
backend_spec = {"mcp": {"prefixMode": "Always", "failureMode": "FailOpen", "targets": targets}}
traffic = {
    "authorization": {
        "action": "Allow",
        "policy": {"matchExpressions": [f'jwt.scope == "mcp" && jwt.org == "{org}"']},
    },
    "transformation": {"request": {"remove": ["x-guild-mcp-caller-email"]}},
}
route = new_resource(route_api, "HTTPRoute", backend, {
    "parentRefs": [{"name": "guild-ai", "sectionName": "ai"}],
    "rules": [{
        "matches": [{"path": {"type": "Exact", "value": f"/mcp/{org}"}}],
        "backendRefs": [{"group": "agentgateway.dev", "kind": "AgentgatewayBackend", "name": backend}],
    }],
})
policy = new_resource(api, "AgentgatewayPolicy", backend, {
    "targetRefs": [{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "name": backend}],
    "traffic": traffic,
    "backend": {"mcp": {"authorization": {"action": "Allow", "policy": {"matchExpressions": rules}}}},
})
items = [new_resource(api, "AgentgatewayBackend", backend, backend_spec), route, policy]
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))
