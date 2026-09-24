use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{full_state, standalone_listener};
use serde_json::{json, Value};
use tower::ServiceExt;

/// A turn submits the durable ChatRunner workflow (spec 2026-09-18
/// unification §4 phase 4): the endpoint acknowledges the invocation; the
/// server itself executes the turn's tools in the org workspace. The deep
/// execution behavior (tools run journaled, exec-policy-gated, history in
/// the thread journal) is verified by the live E2E — like every gateway
/// workflow path, in-repo tests would need an embedded Restate runtime
/// (see the gateway test notes).
#[tokio::test]
async fn workspace_turn_submits_the_durable_workflow() {
    // Accept every ingress POST (the workflow runs detached — the test only
    // asserts the submission contract).
    let restate = wiremock::MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(
            wiremock::ResponseTemplate::new(202)
                .set_body_json(json!({"invocationId":"inv-fixture"})),
        )
        .mount(&restate)
        .await;

    let fs = full_state().await;
    let mut cfg = (*fs.state.config).clone();
    cfg.restate_url = restate.uri();
    let state = guild_server::state::AppState::from_config(cfg);
    let app = guild_server::build_router(state);

    // create a session
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"workspace_name": "repo-a"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let session_id = v["id"].as_str().unwrap().to_string();

    // duplicate name → 409
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"workspace_name": "repo-a"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // invalid name → 400
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"workspace_name": "../escape"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // submit a turn: the durable workflow is invoked, the ack carries the
    // invocation identity (submit + poll — history is the thread journal)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/agents/sessions/{session_id}/turns"))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"message": "set up the repo", "model": "gpt-test"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["accepted"], true, "{v}");
    assert!(v["invocation_id"].as_str().is_some(), "{v}");

    // session appears in the list
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8(body.to_vec()).unwrap().contains("repo-a"));
}

#[tokio::test]
async fn agent_turn_enforces_route_quota() {
    let fs = full_state().await;
    fs.store()
        .gateway()
        .upsert_route(
            fs.org_id,
            "gpt-test",
            "openai",
            true,
            1.0,
            2.0,
            Some(0.0),
            false,
            None,
            None,
            &[],
        )
        .await
        .unwrap();
    let app = guild_server::build_router(fs.state.clone());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"workspace_name": "quota-ws"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let session_id = v["id"].as_str().unwrap().to_string();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/agents/sessions/{session_id}/turns"))
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"message": "spend money", "model": "gpt-test"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);

    // The rejected turn persisted nothing.
    let res = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/v1/agents/sessions/{session_id}"))
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["events"].as_array().unwrap().len(), 0);
}

/// A session create that loses the workspace-name race must not leave its
/// pre-created chat orphaned.
#[tokio::test]
async fn workspace_name_conflict_leaves_no_orphan_chat() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let create = |name: &str| {
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"workspace_name": name}).to_string()))
                .unwrap(),
        )
    };
    assert_eq!(create("dup-ws").await.unwrap().status(), StatusCode::OK);
    assert_eq!(
        create("dup-ws").await.unwrap().status(),
        StatusCode::CONFLICT
    );

    let chats: i64 = sqlx::query_scalar("SELECT count(*) FROM chats WHERE title = 'dup-ws'")
        .fetch_one(fs.store().pool())
        .await
        .unwrap();
    assert_eq!(chats, 1, "the conflicted create's chat was removed");
}

/// A workspace dir left behind by a deleted account is reclaimed when the
/// same workspace name is taken again: the next user must not inherit the
/// previous account's files.
#[tokio::test]
async fn an_orphaned_workspace_dir_is_reclaimed_on_recreate() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(json!({"workspace_name": "repo-x"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let dir = std::path::Path::new(&fs.state.config.data_dir)
        .join("workspaces")
        .join(fs.org_id.to_string())
        .join("repo-x");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("secret.txt"), "previous account's data").unwrap();

    // The account (and its session row) goes away; the dir stays.
    sqlx::query("DELETE FROM agent_sessions WHERE workspace_name = 'repo-x' AND org_id = $1")
        .bind(fs.org_id)
        .execute(fs.store().pool())
        .await
        .unwrap();
    assert!(dir.join("secret.txt").exists());

    // A new user takes the same name: the dir is reclaimed.
    let other = fs
        .store()
        .identity()
        .create_user(fs.org_id, "next@example.org", "hunter226", "member")
        .await
        .unwrap();
    let next_token = {
        let (_sid, token) = fs
            .store()
            .identity()
            .create_session(other.id)
            .await
            .unwrap();
        token
    };
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {next_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"workspace_name": "repo-x"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        !dir.join("secret.txt").exists(),
        "the orphaned files must not reach the new user"
    );
    assert!(dir.exists(), "a fresh empty workspace dir is created");
}

/// A reclaim that cannot run (the org workspace dir was made non-writable,
/// so `remove_dir_all` cannot unlink the orphan) must fail the session
/// create loudly: silently proceeding would let the new session inherit
/// the orphan's files — exactly what the reclaim exists to prevent.
#[cfg(unix)]
#[tokio::test]
async fn an_unreclaimable_orphan_dir_fails_the_session_create() {
    use std::os::unix::fs::PermissionsExt;

    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let org_dir = std::path::Path::new(&fs.state.config.data_dir)
        .join("workspaces")
        .join(fs.org_id.to_string());
    std::fs::create_dir_all(&org_dir).unwrap();
    let dir = org_dir.join("locked-x");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("secret.txt"), "previous account's data").unwrap();

    // No live session row holds the name, so the create takes the reclaim
    // branch. `remove_dir_all` deletes depth-first and unlinks the top dir
    // last; making the ORPHAN DIR itself non-writable stops the first
    // unlink (its contents) — so the orphan's files demonstrably survive.
    let mut perms = std::fs::metadata(&dir).unwrap().permissions();
    perms.set_mode(0o500);
    std::fs::set_permissions(&dir, perms.clone()).unwrap();

    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/agents/sessions")
                .header("authorization", format!("Bearer {}", fs.token))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"workspace_name": "locked-x"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    perms.set_mode(0o700);
    std::fs::set_permissions(&dir, perms).unwrap();

    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("reclaim failed"),
        "the reclaim failure is propagated, got: {body}"
    );
    // The orphan's files survived: nothing was silently inherited.
    assert!(dir.join("secret.txt").exists());
}
