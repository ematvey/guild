use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{insert_org_with_chat, test_state_with_db};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn create_list_messages_and_org_isolation() {
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

    // append messages via store (gateway normally does this)
    store
        .chats()
        .append_message(
            chat["id"].as_str().unwrap().parse().unwrap(),
            "user",
            "hello",
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store
        .chats()
        .append_message(
            chat["id"].as_str().unwrap().parse().unwrap(),
            "assistant",
            "hi!",
            None,
            None,
            Some(1),
            Some(1),
            Some(0.01),
        )
        .await
        .unwrap();

    // list messages via API: ordered, full content
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
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let msgs = v["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[0]["content"], "hello");
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["content"], "hi!");
    assert_eq!(msgs[1]["cost_usd"], 0.01);

    // foreign org's chat is invisible: 404
    let foreign = insert_org_with_chat(&store).await;
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/chats/{foreign}/messages"))
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
