//! Project routes (spec §2): CRUD roundtrip, folder-derived names, machine
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn projects_crud_roundtrip_with_delete_unlink() {
    let fs = full_state().await;
    register_test_machine(
        &fs.state,
        "machine-1",
        fs.user_id,
        fs.org_id,
        Some("WORKSTATION"),
    )
    .await;
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

    // Duplicate name is fine now (names are folder-derived labels); an
    // omitted name defaults to the folder's basename; machine must be
    // registered.
    let (status, body) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"name": "web", "folder": "C:\\x", "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "web");
    let (status, body) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"folder": r"\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo2", "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "repo2");
    let (status, body) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"folder": "\\\\wsl.localhost\\Ubuntu-22.04\\", "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "Ubuntu-22.04");
    let (status, _) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"name": "ghost", "folder": "C:\\x", "machine_id": "no-such-machine"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // List shows the projects.
    let (status, body) = get_json(&app, &fs, "/api/v1/projects").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["projects"].as_array().unwrap().len(), 4);

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
        .get_chat(
            fs.org_id,
            chat.id,
            &fs.store().identity().get_user(fs.user_id).await.unwrap(),
        )
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
        .get_chat(
            fs.org_id,
            chat.id,
            &fs.store().identity().get_user(fs.user_id).await.unwrap(),
        )
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
        .get_chat(
            fs.org_id,
            chat.id,
            &fs.store().identity().get_user(fs.user_id).await.unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after.project_id, None);
    let (status, body) = get_json(&app, &fs, "/api/v1/projects").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["projects"].as_array().unwrap().len(), 3);
}

/// Bind-time machine inheritance: a chat bound to a project runs where the
/// project's folder lives — the project's machine is set at bind time (chat
/// create and POST /chats/{id}/project) and cleared when the project
/// unbinds. Machine binding is project-derived; there is no per-chat choice.
#[tokio::test]
async fn project_binding_inherits_the_projects_machine() {
    let fs = full_state().await;
    register_test_machine(
        &fs.state,
        "machine-1",
        fs.user_id,
        fs.org_id,
        Some("WORKSTATION"),
    )
    .await;
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
    let project_id = project["id"]
        .as_str()
        .unwrap()
        .parse::<uuid::Uuid>()
        .unwrap();

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

    // A legacy create that still carries machine_id (old installed client):
    // the field left the API and is ignored — the project's machine wins and
    // a projectless create stays unbound either way.
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

    // An existing unbound chat aligns to machine-2 when the project is
    // bound afterwards.
    let (status, chat2) =
        post_json(&app, &fs, "POST", "/api/v1/chats", json!({"title": "c2"})).await;
    assert_eq!(status, StatusCode::OK, "{chat2}");
    assert_eq!(chat2["machine_id"], Value::Null);
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

    // Unbinding the project clears the machine binding with it — a
    // machine-bound chat with no project is not a valid state.
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
    assert_eq!(unbound["machine_id"], Value::Null);
}

/// Editing a project's machine re-binds its chats in the same transaction:
/// a chat bound to a project runs where the project's folder lives, so its
/// cached executor may never go stale against the edited folder.
#[tokio::test]
async fn editing_a_projects_machine_rebinds_its_chats() {
    let fs = full_state().await;
    register_test_machine(
        &fs.state,
        "machine-1",
        fs.user_id,
        fs.org_id,
        Some("WORKSTATION"),
    )
    .await;
    register_test_machine(&fs.state, "machine-2", fs.user_id, fs.org_id, Some("NODE2")).await;
    let app = guild_server::build_router(fs.state.clone());

    let (status, project) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/projects",
        json!({"name": "repo", "folder": "C:\\code\\repo", "machine_id": "machine-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{project}");
    let project_id = project["id"]
        .as_str()
        .unwrap()
        .parse::<uuid::Uuid>()
        .unwrap();

    let (status, chat) = post_json(
        &app,
        &fs,
        "POST",
        "/api/v1/chats",
        json!({"title": "c1", "project_id": project_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(chat["machine_id"], "machine-1");

    // Edit the project's executor: bound chats follow, including the label.
    let (status, body) = post_json(
        &app,
        &fs,
        "PUT",
        &format!("/api/v1/projects/{project_id}"),
        json!({"machine_id": "machine-2"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["machine_id"], "machine-2");
    assert_eq!(body["machine_label"], "NODE2");

    let chat_id: uuid::Uuid = chat["id"].as_str().unwrap().parse().unwrap();
    let after = fs
        .store()
        .chats()
        .get_chat(
            fs.org_id,
            chat_id,
            &fs.store().identity().get_user(fs.user_id).await.unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after.machine_id.as_deref(), Some("machine-2"));
    assert_eq!(after.machine_label.as_deref(), Some("NODE2"));

    // The label rule is uniform on every write path: registry label, with
    // the machine id as the fallback when the machine is unlabelled.
    register_test_machine(&fs.state, "machine-3", fs.user_id, fs.org_id, None).await;
    let (status, body) = post_json(
        &app,
        &fs,
        "PUT",
        &format!("/api/v1/projects/{project_id}"),
        json!({"machine_id": "machine-3"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["machine_label"], "machine-3");
    let after = fs
        .store()
        .chats()
        .get_chat(
            fs.org_id,
            chat_id,
            &fs.store().identity().get_user(fs.user_id).await.unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after.machine_label.as_deref(), Some("machine-3"));
}

/// Binding a chat to a project requires owning the project: another
/// member's project, an unknown id, and another org's project are all not
/// found and leave the binding unchanged; an explicit null still unbinds.
#[tokio::test]
async fn binding_a_foreign_or_unknown_project_is_not_found() {
    let fs = full_state().await;
    register_test_machine(&fs.state, "machine-1", fs.user_id, fs.org_id, Some("MINE")).await;
    let app = guild_server::build_router(fs.state.clone());
    let own = fs
        .store()
        .projects()
        .create(fs.org_id, fs.user_id, "own", "C:\\own", "machine-1")
        .await
        .unwrap();
    let chat = fs
        .store()
        .chats()
        .create_chat(fs.org_id, fs.user_id, Some("c"), None)
        .await
        .unwrap();
    let (status, _) = post_json(
        &app,
        &fs,
        "POST",
        &format!("/api/v1/chats/{}/project", chat.id),
        json!({"project_id": own.id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Member B's project on B's machine.
    let member = fs
        .store()
        .identity()
        .create_user(fs.org_id, "b@p.test", "hunter226", "member")
        .await
        .unwrap();
    register_test_machine(&fs.state, "machine-b", member.id, fs.org_id, Some("BBOX")).await;
    let foreign = fs
        .store()
        .projects()
        .create(fs.org_id, member.id, "theirs", "C:\\theirs", "machine-b")
        .await
        .unwrap();

    // Another org's project.
    let other_chat = guild_server::test_support::insert_org_with_chat(&fs.store()).await;
    let (other_org, other_user): (uuid::Uuid, uuid::Uuid) =
        sqlx::query_as("SELECT org_id, user_id FROM chats WHERE id = $1")
            .bind(other_chat)
            .fetch_one(fs.store().pool())
            .await
            .unwrap();
    register_test_machine(&fs.state, "machine-x", other_user, other_org, Some("XBOX")).await;
    let cross_org = fs
        .store()
        .projects()
        .create(other_org, other_user, "x", "C:\\x", "machine-x")
        .await
        .unwrap();

    let user = fs.store().identity().get_user(fs.user_id).await.unwrap();
    for pid in [foreign.id, uuid::Uuid::now_v7(), cross_org.id] {
        let (status, body) = post_json(
            &app,
            &fs,
            "POST",
            &format!("/api/v1/chats/{}/project", chat.id),
            json!({"project_id": pid}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{pid}: {body}");
        let row = fs
            .store()
            .chats()
            .get_chat(fs.org_id, chat.id, &user)
            .await
            .unwrap();
        assert_eq!(row.project_id, Some(own.id));
        assert_eq!(row.machine_id.as_deref(), Some("machine-1"));
    }

    let (status, unbound) = post_json(
        &app,
        &fs,
        "POST",
        &format!("/api/v1/chats/{}/project", chat.id),
        json!({"project_id": null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unbound}");
    assert_eq!(unbound["project_id"], Value::Null);
}
