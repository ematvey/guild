//! Project routes (spec §2): CRUD roundtrip, duplicate-name 409, machine
//! validation, chat binding, and delete-unlinks-chats.

#![cfg(feature = "test-support")]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::{full_state, register_test_machine, FullState};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn post_json(
    app: &axum::Router,
    fs: &FullState,
    method: &str,
    uri: &str,
    body: Value,
) -> (StatusCode, Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("authorization", format!("Bearer {}", fs.token))
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
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, body)
}

async fn get_json(app: &axum::Router, fs: &FullState, uri: &str) -> (StatusCode, Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("authorization", format!("Bearer {}", fs.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn projects_crud_roundtrip_with_name_conflict_and_delete_unlink() {
    let fs = full_state().await;
    register_test_machine(&fs.state, "machine-1", fs.user_id, fs.org_id, Some("WORKSTATION")).await;
    let app = guild_server::build_router(fs.state.clone());

    // Create → full row shape (machine label joined from the registry).
    let (status, body) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"name": "web", "folder": r"\\wsl.localhost\Ubuntu-22.04\home\u\repo", "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let project_id = body["id"].as_str().unwrap().parse::<uuid::Uuid>().unwrap();
    assert_eq!(body["name"], "web");
    assert_eq!(body["machine_id"], "machine-1");
    assert_eq!(body["machine_label"], "WORKSTATION");
    assert_eq!(body["folder"], r"\\wsl.localhost\Ubuntu-22.04\home\u\repo");

    // Duplicate name → 409, machine must be registered.
    let (status, body) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"name": "web", "folder": "C:\\x", "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "project_name_taken");
    let (status, _) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"name": "ghost", "folder": "C:\\x", "machine_id": "no-such-machine"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // List shows the project.
    let (status, body) = get_json(&app, &fs, "/api/v1/projects").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["projects"].as_array().unwrap().len(), 1);

    // Update: rename + refolder.
    let (status, body) = post_json(
        &app,
        &fs,
        "PUT",
        &format!("/api/v1/projects/{project_id}"),
        json!({"name": "web2", "folder": "C:\\code\\web2"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "web2");
    assert_eq!(body["folder"], r"C:\code\web2");

    // Bind a chat to the project: the thread list carries project fields.
    let chat = fs
        .store()
        .chats()
        .create_chat(fs.org_id, fs.user_id, Some("bound"), Some(project_id))
        .await
        .unwrap();
    let (status, body) = get_json(&app, &fs, "/api/v1/chats").await;
    assert_eq!(status, StatusCode::OK);
    let row = body["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == chat.id.to_string())
        .unwrap();
    assert_eq!(row["project_id"], project_id.to_string());
    assert_eq!(row["project_name"], "web2");

    // Rebind via the chat project endpoint; clearing (empty) works too.
    let project_b = fs
        .store()
        .projects()
        .create(fs.org_id, fs.user_id, "b", "C:\\b", "machine-1")
        .await
        .unwrap();
    let (status, _) = post_json(
        &app,
        &fs,
        "POST",
        &format!("/api/v1/chats/{}/project", chat.id),
        json!({"project_id": project_b.id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let bound = fs
        .store()
        .chats()
        .get_chat(fs.org_id, chat.id, &fs.store().identity().get_user(fs.user_id).await.unwrap())
        .await
        .unwrap();
    assert_eq!(bound.project_id, Some(project_b.id));

    // Another member of the org cannot touch the owner's project.
    let member = fs
        .store()
        .identity()
        .create_user(fs.org_id, "member@p.test", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, member_token) = fs
        .store()
        .identity()
        .create_session(member.id)
        .await
        .unwrap();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/projects/{project_id}"))
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "hijack"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // Delete unlinks the referencing chat (project_id → NULL), not 409.
    let (status, _) = post_json(
        &app,
        &fs,
        "DELETE",
        &format!("/api/v1/projects/{project_id}"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let after = fs
        .store()
        .chats()
        .get_chat(fs.org_id, chat.id, &fs.store().identity().get_user(fs.user_id).await.unwrap())
        .await
        .unwrap();
    assert_eq!(after.project_id, Some(project_b.id));
    let (status, _) = post_json(
        &app,
        &fs,
        "DELETE",
        &format!("/api/v1/projects/{}", project_b.id),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let after = fs
        .store()
        .chats()
        .get_chat(fs.org_id, chat.id, &fs.store().identity().get_user(fs.user_id).await.unwrap())
        .await
        .unwrap();
    assert_eq!(after.project_id, None);
    let (status, body) = get_json(&app, &fs, "/api/v1/projects").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["projects"].as_array().unwrap().len(), 0);
}

/// Bind-time machine inheritance: a chat bound to a project runs where the
/// project's folder lives — the project's machine is set at bind time (chat
/// create and POST /chats/{id}/project), and a per-chat rebind is a later
/// override, never a stale mismatch.
#[tokio::test]
async fn project_binding_inherits_the_projects_machine() {
    let fs = full_state().await;
    register_test_machine(&fs.state, "machine-1", fs.user_id, fs.org_id, Some("WORKSTATION")).await;
    register_test_machine(&fs.state, "machine-2", fs.user_id, fs.org_id, Some("NODE2")).await;
    let app = guild_server::build_router(fs.state.clone());

    // A project on machine-2 with a WSL UNC folder.
    let (status, project) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"name": "wslrepo", "folder": r"\\wsl.localhost\\Ubuntu\\home\\u\\repo", "machine_id": "machine-2"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{project}");
    let project_id = project["id"].as_str().unwrap().parse::<uuid::Uuid>().unwrap();

    // Chat created with the project inherits the project's machine.
    let (status, chat) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/chats",
        json!({"title": "c1", "project_id": project_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(chat["machine_id"], "machine-2");
    assert_eq!(chat["machine_label"], "NODE2");

    // A create that carries both fields takes the project's machine — the
    // production path (the desktop always sends its auto-bind alongside the
    // picked project).
    let (status, both) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/chats",
        json!({"title": "c1-both", "project_id": project_id, "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{both}");
    assert_eq!(both["machine_id"], "machine-2");

    // An existing chat bound to machine-1 re-aligns to machine-2 when the
    // project is bound afterwards.
    let (status, chat2) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/chats",
        json!({"title": "c2", "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chat2}");
    assert_eq!(chat2["machine_id"], "machine-1");
    let chat2_id = chat2["id"].as_str().unwrap();
    let (status, bound) = post_json(
        &app,
        &fs,
        "POST",
        &format!("/api/v1/chats/{chat2_id}/project"),
        json!({"project_id": project_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{bound}");
    assert_eq!(bound["project_id"], project_id.to_string());
    assert_eq!(bound["machine_id"], "machine-2");
    assert_eq!(bound["machine_label"], "NODE2");

    // The per-chat machine bind stays an override AFTER a bind.
    let (status, rebound) = post_json(
        &app,
        &fs,
        "POST",
        &format!("/api/v1/chats/{chat2_id}/machine"),
        json!({"machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rebound}");
    assert_eq!(rebound["machine_id"], "machine-1");
    assert_eq!(rebound["project_id"], project_id.to_string());

    // Unbinding the project keeps the current machine.
    let (status, unbound) = post_json(
        &app,
        &fs,
        "POST",
        &format!("/api/v1/chats/{chat2_id}/project"),
        json!({"project_id": null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unbound}");
    assert_eq!(unbound["project_id"], Value::Null);
    assert_eq!(unbound["machine_id"], "machine-1");
}
