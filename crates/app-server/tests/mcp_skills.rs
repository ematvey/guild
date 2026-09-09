use guild_app_server::mcp;
use serde_json::json;
use std::path::Path;

/// Minimal MCP stdio fixture server (JSON-RPC over line-delimited stdio).
const FIXTURE_PY: &str = r#"
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if "id" not in msg or msg["id"] is None:
        continue  # notifications need no reply
    method = msg.get("method", "")
    if method == "initialize":
        resp = {"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": msg["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fixture", "version": "0.1"}}}
    elif method == "tools/list":
        resp = {"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [{
            "name": "echo",
            "description": "echo the given text back",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}}
    elif method == "tools/call":
        text = msg["params"]["arguments"].get("text", "")
        resp = {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": text}]}}
    else:
        resp = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "unknown"}}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
"#;

fn setup_project(tag: &str, mcp_json: Option<&str>) -> (std::path::PathBuf, std::path::PathBuf) {
    let project = std::env::temp_dir().join(format!("guild-mcp-{tag}-{}", std::process::id()));
    let config = project.join("cfg");
    std::fs::create_dir_all(&config).unwrap();
    if let Some(mcp) = mcp_json {
        let guild = project.join(".guild");
        std::fs::create_dir_all(&guild).unwrap();
        std::fs::write(guild.join("mcp.json"), mcp).unwrap();
    }
    (project, config)
}

fn script_path(project: &Path) -> std::path::PathBuf {
    let p = project.join("fixture_server.py");
    std::fs::write(&p, FIXTURE_PY).unwrap();
    p
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixture_server_connects_and_tool_calls() {
    let (project, config) = setup_project(
        "conn",
        Some(r#"{"servers": {"fixture": {"command": ["python3", "PLACEHOLDER"]}}}"#),
    );
    let script = script_path(&project);
    // patch the placeholder with the real script path
    std::fs::write(
        project.join(".guild/mcp.json"),
        json!({"servers": {"fixture": {"command": ["python3", script.to_str().unwrap()]}}})
            .to_string(),
    )
    .unwrap();

    let handles = mcp::connect_all(&project, &config).await;
    assert_eq!(handles.len(), 1, "fixture server should connect");
    let (name, handle) = &handles[0];
    assert_eq!(name, "fixture");
    let specs = handle.tools();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].name, "mcp_fixture_echo");

    // run through the registry like the agent does
    let mut registry = guild_core::tools::ToolRegistry::builtins();
    for wrapper in handle.tool_wrappers() {
        registry.add(wrapper);
    }
    let out = registry
        .run("mcp_fixture_echo", &project, json!({"text": "ping pong"}))
        .await
        .unwrap();
    assert_eq!(out.output_for_model, "ping pong");

    // schema validation applies to MCP tools too
    let err = registry
        .run("mcp_fixture_echo", &project, json!({"wrong": 1}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("failed validation"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn broken_server_is_skipped_not_fatal() {
    let (project, config) = setup_project(
        "broken",
        Some(r#"{"servers": {"bad": {"command": ["definitely-not-a-real-binary-xyz"]}}}"#),
    );
    let handles = mcp::connect_all(&project, &config).await;
    assert!(handles.is_empty(), "broken server skipped");
    let (no_cfg, no_cfg_dir) = setup_project("none", None);
    assert!(mcp::connect_all(&no_cfg, &no_cfg_dir).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_and_user_mcp_json_merge() {
    let (project, config) = setup_project(
        "merge",
        Some(r#"{"servers": {"proj-srv": {"url": "http://127.0.0.1:1/x"}}}"#),
    );
    std::fs::write(
        config.join("mcp.json"),
        json!({"servers": {"user-srv": {"url": "http://127.0.0.1:1/y"}}}).to_string(),
    )
    .unwrap();
    let servers = mcp::load_servers(&project, &config);
    assert!(servers.contains_key("proj-srv"));
    assert!(servers.contains_key("user-srv"));
}
