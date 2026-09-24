//! Browser-mode e2e: the guild-server serves the web app at `/` (the same
//! frontend the Tauri desktop app runs), plus the exact API flow
//! `transport.ts` performs in web mode (login → models → create chat → SSE
//! stream → history).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::serve_full;
use serde_json::json;
use tower::ServiceExt;

async fn get(app: &axum::Router, uri: &str) -> axum::response::Response {
    app.clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn body(res: axum::response::Response) -> String {
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    String::from_utf8_lossy(&bytes).to_string()
}

fn first_asset(html: &str, marker: &str) -> Option<String> {
    html.split(marker)
        .nth(1)?
        .split('"')
        .next()
        .map(String::from)
}

#[tokio::test]
async fn chat_app_is_served() {
    let app = guild_server::build_router(guild_server::test_support::test_state());

    // chat app at `/`
    let res = get(&app, "/").await;
    if res.status() == StatusCode::SERVICE_UNAVAILABLE {
        eprintln!("SKIP: frontend not built (npm run build in apps/desktop)");
        return;
    }
    assert_eq!(res.status(), StatusCode::OK);
    // Web mode ships a CSP: no remote img/script channels (model-controlled
    // markdown must not be able to exfiltrate or load remote content).
    let csp = res
        .headers()
        .get("content-security-policy")
        .expect("web CSP header")
        .to_str()
        .unwrap()
        .to_string();
    assert!(csp.contains("script-src 'self'"), "csp: {csp}");
    assert!(!csp.contains("img-src 'self' http"), "csp: {csp}");
    let html = body(res).await;
    assert!(
        html.contains("<div id=\"root\">"),
        "chat index html: {html}"
    );
    // Every inline <script> block in the served HTML is allowed by hash —
    // the theme pre-paint, pinch-zoom guard and service-worker unregister
    // scripts must actually run under web mode's CSP.
    let inline = html
        .match_indices("<script")
        .filter(|(i, _)| {
            let tag_end = html[*i..].find('>').unwrap();
            !html[*i..*i + tag_end].contains(" src=")
        })
        .count();
    let hashes = csp.matches("'sha256-").count();
    assert_eq!(hashes, inline, "csp must allow every inline script: {csp}");
    assert!(hashes > 0, "index.html is expected to carry inline scripts");
    let asset = first_asset(&html, "src=\"").expect("chat index references a js asset");
    assert!(asset.starts_with("/assets/"), "chat asset path: {asset}");
    assert_eq!(get(&app, &asset).await.status(), StatusCode::OK);

    // API fallthrough preserved: unknown API path is the JSON error envelope
    let res = get(&app, "/api/v1/nope").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert!(body(res).await.contains("\"error\""));
    assert_eq!(get(&app, "/api/v1/health").await.status(), StatusCode::OK);
}

/// The full web-mode flow: same-origin login, model discovery, chat create,
/// SSE streaming turn, and persisted history — exactly what the browser
/// chat app does.
// Ignored: gateway chat routes through the Restate ChatRunner and tests have
// no Restate runtime (placeholder restate_url). Un-ignore once tests embed Restate.
#[ignore = "gateway chat needs an embedded Restate runtime in tests; placeholder restate_url"]
#[tokio::test]
async fn web_chat_flow_login_models_chat_stream_history() {
    let srv = serve_full().await;
    let app = guild_server::build_router(srv.full.state.clone());

    // login (transport.apiLogin)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email": "a@b.c", "password": "hunter226"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: serde_json::Value = serde_json::from_str(&body(res).await).unwrap();
    let token = v["token"].as_str().unwrap().to_string();
    let auth = format!("Bearer {token}");

    // model discovery (the selector dropdown)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/gateway/models")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: serde_json::Value = serde_json::from_str(&body(res).await).unwrap();
    assert!(v["models"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m.as_str() == Some(srv.model.as_str())));

    // create chat (transport.createChat)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(json!({"title": "web chat"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: serde_json::Value = serde_json::from_str(&body(res).await).unwrap();
    let chat_id = v["id"].as_str().unwrap().to_string();

    // stream a turn (transport.streamChat → POST /api/v1/gateway/chat)
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "chat_id": chat_id,
                        "model": srv.model,
                        "messages": [{"role": "user", "content": "greet"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let sse = body(res).await;
    let events: Vec<serde_json::Value> = sse
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    assert!(events
        .iter()
        .any(|e| e["type"] == "delta" && e["content"].as_str() == Some("hi there")));
    let done = events
        .iter()
        .find(|e| e["type"] == "done")
        .expect("stream done event");
    assert!(done["tokens_in"].as_i64() == Some(5));
    assert!(done["tokens_out"].as_i64() == Some(2));

    // turn persisted: system + user + assistant thread events
    let events = srv
        .store()
        .thread()
        .list_events(srv.full.org_id, chat_id.parse().unwrap())
        .await
        .unwrap();
    let texts: Vec<String> = events
        .iter()
        .flat_map(|e| match &e.event {
            protocol::api::ThreadEvent::UserMessage { content, .. } => {
                vec![format!("user:{content}")]
            }
            protocol::api::ThreadEvent::AssistantMessage { blocks, .. } => blocks
                .iter()
                .filter_map(|b| match b {
                    protocol::api::Block::Text { text } => Some(format!("assistant:{text}")),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        })
        .collect();
    assert_eq!(texts, vec!["user:greet", "assistant:hi there"]);
}
