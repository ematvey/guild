"""Render the synthetic MCP route and the explicit tool allowlist."""
import json
import sys
import uuid

organization = str(uuid.UUID(sys.argv[1]))
name = "fixture-mcp"

def resource(kind, spec, api_version="agentgateway.dev/v1alpha1"):
    return {
        "apiVersion": api_version,
        "kind": kind,
        "metadata": {"name": name, "namespace": "guild-experiment"},
        "spec": spec,
    }

items = [
    resource("AgentgatewayBackend", {
        "mcp": {
            "prefixMode": "Always",
            "targets": [{
                "name": "fixture",
                "static": {
                    "host": "guild-mcp-fixture.guild-experiment.svc.cluster.local",
                    "port": 8080, "path": "/mcp", "protocol": "StreamableHTTP",
                    "policies": {"auth": {"secretRef": {"name": "guild-mcp-fixture-provider"}}},
                },
            }],
        },
    }),
    resource("HTTPRoute", {
        "parentRefs": [{"name": "guild-ai", "sectionName": "ai"}],
        "rules": [{
            "matches": [{"path": {"type": "Exact", "value": f"/mcp/{organization}"}}],
            "backendRefs": [{"group": "agentgateway.dev", "kind": "AgentgatewayBackend", "name": name}],
        }],
    }, "gateway.networking.k8s.io/v1"),
    resource("AgentgatewayPolicy", {
        "targetRefs": [{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "name": name}],
        "traffic": {
            "authorization": {
                "action": "Allow",
                "policy": {"matchExpressions": [f"jwt.scope == 'mcp' && jwt.org == '{organization}'"]},
            },

        },
        "backend": {"mcp": {"authorization": {
            "action": "Allow",
            "policy": {"matchExpressions": ["mcp.tool.name == 'echo_allowed'"]},
        }}},
    }),
]
if "--with-searxng" in sys.argv:
    items[0]["spec"]["mcp"]["targets"].append({
        "name": "searxng",
        "static": {
            "host": "guild-mcp-searxng.guild-experiment.svc.cluster.local",
            "port": 8080, "path": "/mcp", "protocol": "StreamableHTTP",
            "policies": {"auth": {"secretRef": {"name": "guild-mcp-searxng-access"}}},
        },
    })
    match = items[2]["spec"]["backend"]["mcp"]["authorization"]["policy"]["matchExpressions"]
    match[0] = "mcp.tool.target == 'fixture' && mcp.tool.name == 'echo_allowed'"
    match.append("mcp.tool.target == 'searxng' && mcp.tool.name == 'web_search'")
if "--with-google" in sys.argv:
    items[0]["spec"]["mcp"]["targets"].append({
        "name": "google-workspace",
        "static": {
            "host": "guild-mcp-google-workspace.guild-experiment.svc.cluster.local",
            "port": 8080, "path": "/mcp", "protocol": "StreamableHTTP",
            "policies": {"auth": {"passthrough": {}}},
        },
    })
    match = items[2]["spec"]["backend"]["mcp"]["authorization"]["policy"]["matchExpressions"]
    match.append("mcp.tool.target == 'google-workspace' && mcp.tool.name == 'drive_get_file'")
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))
