use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{insert_org_with_chat, register_test_machine, test_state_with_db};
use protocol::api::{Block, ThreadEvent, UsagePayload};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn create_list_thread_and_org_isolation() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&token).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    // create chat via API
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"title": "my chat"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let chat: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_string();
    let chat_uuid: uuid::Uuid = chat_id.parse().unwrap();

    // append events via the thread store (the ChatRunner normally does this)
    store
        .thread()
        .append_event(
            chat_uuid,
            &ThreadEvent::UserMessage {
                content: "hello".into(),
                attachments: Vec::new(),
            },
        )
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat_uuid,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 0,
                blocks: vec![Block::Text { text: "hi!".into() }],
                usage: UsagePayload {
                    tokens_in: Some(1),
                    tokens_out: Some(1),
                    cost_usd: Some(0.01),
                },
                model: "test-model".into(),
                interrupted: None,
            },
        )
        .await
        .unwrap();

    // read the thread via API: ordered, full payloads
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{chat_id}/thread"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let events = v["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["event"]["type"], "user_message");
    assert_eq!(events[0]["event"]["content"], "hello");
    assert_eq!(events[1]["event"]["type"], "assistant_message");
    assert_eq!(events[1]["event"]["blocks"][0]["text"], "hi!");
    assert_eq!(events[1]["event"]["usage"]["cost_usd"], 0.01);
    assert!(events[0]["id"].is_string());
    assert!(events[0]["seq"].is_i64());

    // the old /messages endpoints are gone (spec §E, §F): 404
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{chat_id}/messages"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/messages"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"role": "user", "content": "x"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // foreign org's chat is invisible on /thread: 404
    let foreign = insert_org_with_chat(&store).await;
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{foreign}/thread"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // list chats shows the created chat
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let _ = user_row;
}

/// GET /api/v1/machines lists every durable registry row of the user —
/// offline rows included — with the live `connected` flag from the hub,
/// connected machines first, then last seen descending.
#[tokio::test]
async fn machines_lists_registry_rows_connected_first() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&token).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    // One live machine (hub slot + registry row) and two offline rows:
    // only the registry record exists, the app has long exited.
    register_test_machine(&ts.state, "live-1", user_row.id, user_row.org_id, Some("Live")).await;
    store
        .machines()
        .upsert_connected(
            user_row.org_id,
            user_row.id,
            "off-old",
            Some("OldDesk"),
            None,
            Some("windows"),
            Some("11"),
            Some("0.4.0"),
            Some("10.1.2.3"),
        )
        .await
        .unwrap();
    store
        .machines()
        .upsert_connected(user_row.org_id, user_row.id, "off-recent", None, None, None, None, None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE machines SET last_seen_at = now() - interval '2 days' WHERE machine_id = 'off-old'")
        .execute(store.pool())
        .await
        .unwrap();

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/machines")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let machines: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let list = machines["machines"].as_array().unwrap();
    let ids: Vec<&str> = list
        .iter()
        .map(|m| m["machine_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["live-1", "off-recent", "off-old"]);

    let by_id = |id: &str| list.iter().find(|m| m["machine_id"] == id).unwrap();
    assert_eq!(by_id("live-1")["connected"], true);
    assert_eq!(by_id("off-recent")["connected"], false);
    // Missing fields: label falls back to machine_id, metadata omitted.
    assert_eq!(by_id("off-recent")["name"], "off-recent");
    assert!(by_id("off-recent")["os"].is_null());
    // Offline rows still carry their last connect metadata.
    assert_eq!(by_id("off-old")["connected"], false);
    assert_eq!(by_id("off-old")["name"], "OldDesk");
    assert_eq!(by_id("off-old")["os"], "windows");
    assert_eq!(by_id("off-old")["app_version"], "0.4.0");
    assert_eq!(by_id("off-old")["last_ip"], "10.1.2.3");
    assert!(by_id("off-old")["first_connected_at"].is_string());
    assert!(by_id("off-old")["last_seen_at"].is_string());
}

/// Machine bindings must reference a live hub machine belonging to the
/// caller's user or org; unknown or foreign machines are rejected.
/// Unbinding stays open.
#[tokio::test]
async fn machine_binding_is_project_derived() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("a@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&token).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    register_test_machine(
        &ts.state,
        "desk-1",
        user_row.id,
        user_row.org_id,
        Some("Desk"),
    )
    .await;

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/machines")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let machines: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(machines["machines"][0]["machine_id"], "desk-1");
    assert_eq!(machines["machines"][0]["name"], "Desk");
    // The hub slot from register_test_machine is live.
    assert_eq!(machines["machines"][0]["connected"], true);

    // Create with a project: the project's machine is the authority.
    let (status, project) = post_chat_json(
        &app,
        &token,
        "POST",
        "/api/v1/projects",
        json!({"name": "repo", "folder": r"C:\code\repo", "machine_id": "desk-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{project}");
    let project_id = project["id"].as_str().unwrap();
    let (status, chat) = post_chat_json(
        &app,
        &token,
        "POST",
        "/api/v1/chats",
        json!({"title": "bound", "project_id": project_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(chat["machine_id"], "desk-1");
    assert_eq!(chat["machine_label"], "Desk");
    let chat_id = chat["id"].as_str().unwrap().to_string();

    // A legacy create still carrying machine_id (old installed clients):
    // the field is gone from the API and is ignored — a chat with no project
    // stays fully unbound; there is no machine-bound, no-project state.
    let (status, legacy) = post_chat_json(
        &app,
        &token,
        "POST",
        "/api/v1/chats",
        json!({"title": "legacy", "machine_id": "desk-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{legacy}");
    assert_eq!(legacy["machine_id"], serde_json::Value::Null);
    assert_eq!(legacy["project_id"], serde_json::Value::Null);

    // The per-chat machine endpoint is gone.
    let (status, _) = post_chat_json(
        &app,
        &token,
        "POST",
        &format!("/api/v1/chats/{chat_id}/machine"),
        json!({"machine_id": "desk-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Unbinding the project clears the machine binding with it.
    let (status, unbound) = post_chat_json(
        &app,
        &token,
        "POST",
        &format!("/api/v1/chats/{chat_id}/project"),
        json!({"project_id": null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unbound}");
    assert_eq!(unbound["project_id"], serde_json::Value::Null);
    assert_eq!(unbound["machine_id"], serde_json::Value::Null);
}

/// Helper: an authenticated JSON POST against the app router.
async fn post_chat_json(
    app: &axum::Router,
    token: &str,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

/// Thread-list status over the API: the list carries generating/unread, a
/// read POST clears the dot, and a foreign member cannot mark someone
/// else's chat read.
#[tokio::test]
async fn chat_status_flags_and_read_endpoint() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("status@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid0, tok0) = store.identity().create_session(user).await.unwrap();
    let user_row = store.identity().validate_session(&tok0).await.unwrap();
    let org_id = user_row.org_id;
    let member = store
        .identity()
        .create_user(org_id, "other@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let (_sid2, member_token) = store.identity().create_session(member.id).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let chat_id: uuid::Uuid = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    // fresh chat: idle, read
    let get_list = |app: axum::Router, token: String| async move {
        let res = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/chats")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["chats"]
            .as_array()
            .unwrap()
            .clone()
    };
    let chats = get_list(app.clone(), token.clone()).await;
    assert!(!chats[0]["generating"].as_bool().unwrap());
    assert!(!chats[0]["unread"].as_bool().unwrap());

    // generating flag + an unseen assistant turn (flag suppresses unread)
    store
        .chats()
        .set_generating(org_id, chat_id, true)
        .await
        .unwrap();
    store
        .thread()
        .append_event(
            chat_id,
            &ThreadEvent::AssistantMessage {
                turn: 1,
                step: 0,
                blocks: vec![Block::Text {
                    text: "reply".into(),
                }],
                usage: UsagePayload::default(),
                model: "m".into(),
                interrupted: None,
            },
        )
        .await
        .unwrap();
    let chats = get_list(app.clone(), token.clone()).await;
    assert!(chats[0]["generating"].as_bool().unwrap());
    assert!(!chats[0]["unread"].as_bool().unwrap());

    // turn done: unread dot
    store
        .chats()
        .set_generating(org_id, chat_id, false)
        .await
        .unwrap();
    let chats = get_list(app.clone(), token.clone()).await;
    assert!(chats[0]["unread"].as_bool().unwrap());

    // a foreign member cannot mark it read; the owner can
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/read"))
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/read"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let chats = get_list(app, token).await;
    assert!(!chats[0]["unread"].as_bool().unwrap());
}

#[tokio::test]
async fn chat_approval_mode_roundtrip() {
    let ts = test_state_with_db().await;
    let store = ts.store();
    let user = store
        .identity()
        .ensure_bootstrap_admin("approval-mode@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user).await.unwrap();
    let app = guild_server::build_router(ts.state.clone());
    let auth = format!("Bearer {token}");

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/chats")
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(json!({"title": "policy chat"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let chat_id: String = v["id"].as_str().unwrap().to_string();

    // Default: no override.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    if status != StatusCode::OK {
        panic!("GET approval failed: {} {body:?}", status);
    }
    assert!(v["default"].is_null());

    // Set a mode; read it back.
    for mode in ["approve_for_me", "ask", "full_access"] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/chats/{chat_id}/approval"))
                    .header("authorization", &auth)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"default": mode}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/v1/chats/{chat_id}/approval"))
                    .header("authorization", &auth)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["default"], mode);
    }

    // Unknown mode rejected.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(json!({"default": "yolo"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Reset to the account default.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(json!({"default": "default"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/chats/{chat_id}/approval"))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["default"].is_null());
}

/// A desktop-origin send on a projectless chat stays fully unbound: the
/// ChatRunner payload carries no machine binding (the origin machine id is
/// audit metadata only), so the workflow's tool dispatch falls into the
/// sandbox executor — never auto-dispatched to the sending desktop.
#[tokio::test]
async fn desktop_origin_send_with_no_project_stays_unbound() {
    let (ts, ingress) = guild_server::test_support::test_state_with_mock_ingress().await;
    let store = ts.store();
    let user_id = store
        .identity()
        .ensure_bootstrap_admin("unbound@b.c", "hunter226")
        .await
        .unwrap();
    let (_sid, token) = store.identity().create_session(user_id).await.unwrap();
    let user = store.identity().validate_session(&token).await.unwrap();
    let chat = store
        .chats()
        .create_chat(user.org_id, user.id, Some("gui-only"), None)
        .await
        .unwrap();
    let app = guild_server::build_router(ts.state.clone());

    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/gateway/chat")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                // The desktop origin rides the header, as every desktop send does.
                .header("x-guild-machine-id", "sender-desktop")
                .body(Body::from(
                    json!({
                        "chat_id": chat.id,
                        "model": "gsm",
                        "messages": [{"role": "user", "content": "hi"}],
                        "client_tools": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let generate = ingress
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|(path, _)| path.contains("ChatRunner") && path.contains("/generate"))
        .map(|(_, body)| body.clone())
        .expect("ChatRunner generate invocation recorded");
    assert_eq!(generate["machine_id"], serde_json::Value::Null);
    assert_eq!(generate["machine_label"], serde_json::Value::Null);
    assert_eq!(generate["project_id"], serde_json::Value::Null);
    // Audit metadata only — recorded, never binding.
    assert_eq!(generate["origin_machine_id"], "sender-desktop");
    // Unbound payload ⇒ the workflow's executor resolution has no machine to
    // dispatch to: client_tool_step's sandbox arm (machine_id.is_none()) is
    // the only path. No machine socket is registered in this test, so a
    // machine dispatch is impossible by construction.
}
