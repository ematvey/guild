"""Render agentgateway routes for the synthetic model backends."""
import hashlib
import json
import sys
import uuid

organization = str(uuid.UUID(sys.argv[1]))
objects = []
for protocol, suffix, api_type in (
    ("openai", "/v1/chat/completions", "Completions"),
    ("anthropic", "/v1/messages", "Messages"),
):
    name = f"fixture-{protocol}"
    route_id = hashlib.sha256(name.encode()).hexdigest()[:32]

    def add(kind, spec, api_version="agentgateway.dev/v1alpha1"):
        objects.append({
            "apiVersion": api_version,
            "kind": kind,
            "metadata": {"name": name, "namespace": "guild-experiment"},
            "spec": spec,
        })

    add("AgentgatewayBackend", {
        "ai": {"provider": {
            protocol: {"model": name},
            "host": "guild-llm-fixture.guild-experiment.svc.cluster.local",
            "port": 8080,
            "path": suffix,
        }},
        "policies": {
            "auth": {"secretRef": {"name": "guild-llm-fixture-provider"}},
            "ai": {"routes": {suffix: api_type}},
        },
    })
    add("HTTPRoute", {
        "parentRefs": [{"name": "guild-ai", "sectionName": "ai"}],
        "rules": [{
            "matches": [{"path": {"type": "Exact", "value": f"/llm/{organization}/{protocol}/{route_id}{suffix}"}}],
            "backendRefs": [{"group": "agentgateway.dev", "kind": "AgentgatewayBackend", "name": name}],
        }],
    }, "gateway.networking.k8s.io/v1")
    add("AgentgatewayPolicy", {
        "targetRefs": [{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "name": name}],
        "traffic": {"authorization": {
            "action": "Allow",
            "policy": {"matchExpressions": [
                f"jwt.scope == 'llm' && jwt.org == '{organization}' && jwt.model == '{name}'"
            ]},
        }},
    })
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": objects}))
