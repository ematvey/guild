//! The executor funnel: one module owns suspend → dispatch → watch →
//! resolve for the executor arms (spec 2026-09-18 unification §2.1 —
//! executors are a taxonomy; adding one is a dispatch-shape change, never a
//! loop change). The gate orchestration lives in the workflow's
//! approval/exec-policy steps; everything that happens around the
//! suspension — the suspended-call registry, the machine dispatch with its
//! KV claim, the liveness/stop watchers, and the durable resolution — lives
//! here. All machine tool results resolve through the durable
//! `complete_tool` handler, so late duplicates and replays no-op.

use crate::http::internal::restate_send_one_way;
use crate::state::{AppState, PendingTool};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

/// How long a machine tool may stay suspended before the journaled timeout
/// resolves it (client tools and the AGENTS.md fetch bound their own
/// shorter windows).
pub(crate) const CLIENT_TOOL_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(5 * 60);

/// How long an approval card may wait for a user decision before the gate
/// auto-denies.
pub(crate) const APPROVAL_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(5 * 60);

pub(crate) fn pending_tool_exists(state: &AppState, chat_id: Uuid, call_id: &str) -> bool {
    state.generations.has_pending_tool(chat_id, call_id)
}

/// Watches the bound machine's socket liveness while a machine tool is
/// suspended. If the socket stays offline past the grace window, the tool is
/// resolved with an error so the turn continues instead of dead-airing until
/// the 5-minute timeout. All machine tool results funnel through the same durable `complete_tool`
/// handler, so this stays replay-safe; late duplicate completions no-op.
pub(crate) fn spawn_machine_watcher(
    state: &AppState,
    chat_id: Uuid,
    call_id: String,
    tool_name: String,
    machine_id: String,
    machine_label: String,
    done: Arc<tokio::sync::Notify>,
) {
    let state = state.clone();
    let connection = state
        .generations
        .pending_tool(chat_id, &call_id)
        .and_then(|tool| tool.connection_id);
    let deadline = tokio::time::Instant::now() + CLIENT_TOOL_TIMEOUT;
    tokio::spawn(async move {
        // The grace window covers brief disconnects and reconnects before the
        // tool is declared aborted.
        const GRACE: std::time::Duration = std::time::Duration::from_secs(15);
        let mut gone_since: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                _ = done.notified() => return,
                _ = tokio::time::sleep_until(deadline) => return, // backstop handles it
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
            }
            if !pending_tool_exists(&state, chat_id, &call_id) {
                return; // resolved already
            }
            let current = state.hub.machine_connection(&machine_id);
            if current.is_some() && current != connection {
                reconcile_machine_tools(&state, &machine_id, current.unwrap()).await;
                return;
            }
            if current.is_some() {
                gone_since = None;
                continue;
            }
            let since = *gone_since.get_or_insert_with(tokio::time::Instant::now);
            if since.elapsed() >= GRACE {
                let _ = restate_send_one_way(
                    &state,
                    "ChatRunner",
                    &format!("{chat_id}/complete_tool"),
                    json!({
                        "call_id": call_id,
                        "content": format!(
                            "client tool {tool_name} aborted: the bound machine '{machine_label}' went offline before executing it",
                        ),
                        "is_error": true,
                    }),
                )
                .await;
                return;
            }
        }
    });
}

/// Watches the chat's cancel flag while a client tool is suspended. A stop
/// resolves the tool immediately with an interrupt notice, so the turn
/// resumes and ends at the next journaled cancel check instead of waiting
/// out the executor or the 5-minute timeout. Same durable `complete_tool`
/// funnel as every other resolution; late client results no-op.
pub(crate) fn spawn_stop_watcher(
    state: &AppState,
    chat_id: Uuid,
    call_id: String,
    done: Arc<tokio::sync::Notify>,
) {
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = done.notified() => return,
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            }
            if !pending_tool_exists(&state, chat_id, &call_id) {
                return; // resolved already
            }
            let Some(cancel) = state.generations.cancel_flag(chat_id) else {
                return; // generation gone; the turn cannot resume anyway
            };
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = restate_send_one_way(
                    &state,
                    "ChatRunner",
                    &format!("{chat_id}/complete_tool"),
                    json!({
                        "call_id": call_id,
                        "content": "turn interrupted before the tool result arrived",
                        "is_error": true,
                    }),
                )
                .await;
                return;
            }
        }
    });
}

/// Watches the chat's cancel flag while an approval decision is pending. A
/// stop resolves the gate as denied so the turn resumes and ends at the
/// next journaled cancel check instead of waiting out the user or the
/// auto-deny timer. Duplicate resolutions against an already-resolved
/// awakeable are dropped by Restate; the loser no-ops.
pub(crate) fn spawn_stop_approval_watcher(state: &AppState, chat_id: Uuid, call_id: String) {
    let state = state.clone();
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + APPROVAL_TIMEOUT;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return,
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            }
            let Some(cancel) = state.generations.cancel_flag(chat_id) else {
                return; // generation gone; the turn cannot resume anyway
            };
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = restate_send_one_way(
                    &state,
                    "ChatRunner",
                    &format!("{chat_id}/complete_approval"),
                    json!({
                        "call_id": call_id,
                        "approved": false,
                        "reason": "turn interrupted",
                    }),
                )
                .await;
                return;
            }
        }
    });
}

/// Registers a suspended client tool call for late-attaching clients and
/// returns the watcher's completion signal.
pub(crate) fn note_pending_tool(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    name: &str,
    args: &str,
    machine_id: Option<&str>,
    workdir: Option<&str>,
) -> Arc<tokio::sync::Notify> {
    let done = Arc::new(tokio::sync::Notify::new());
    let holder = machine_id.and_then(|id| state.hub.machine_holder(id));
    state.generations.set_pending_tool(
        chat_id,
        call_id,
        PendingTool {
            name: name.to_string(),
            arguments: args.to_string(),
            machine_id: machine_id.map(str::to_string),
            workdir: workdir.map(str::to_string),
            connection_id: holder.as_ref().map(|m| m.conn_id),
            done: done.clone(),
        },
    );
    done
}

/// Dispatches once inside the worker's journaled operation. The returned
/// connection identity is replayed, not the side effect itself.
pub(crate) async fn dispatch_pending_tool(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    dispatch_id: &str,
) -> Result<Option<Uuid>, crate::http::error::ApiError> {
    let tool = state
        .generations
        .pending_tool(chat_id, call_id)
        .map(|t| {
            (
                t.connection_id,
                t.machine_id,
                t.name,
                t.arguments,
                t.workdir,
            )
        });
    let Some((connection, machine, name, arguments, workdir)) = tool else {
        return Ok(None);
    };
    let store = state.store().await?;
    let key = format!("tool_dispatch:{chat_id}:{dispatch_id}");
    if !store
        .kv()
        .claim(
            &key,
            &connection.map(|id| id.to_string()).unwrap_or_default(),
        )
        .await?
    {
        let recorded = store.kv().get(&key).await?.and_then(|id| id.parse().ok());
        restate_send_one_way(state, "ChatRunner", &format!("{chat_id}/complete_tool"),
            json!({"call_id": call_id, "content": "Dispatch was already reserved; execution outcome is unknown. Check effects before retrying.", "is_error": true})).await?;
        return Ok(recorded);
    }
    let holder = machine
        .as_deref()
        .and_then(|id| state.hub.machine_holder(id));
    if let Some(holder) = holder.filter(|h| Some(h.conn_id) == connection) {
        if holder
            .sink
            .try_send(protocol::ws::WsServerMsg::ToolDispatch {
                chat_id,
                call_id: call_id.into(),
                name,
                arguments,
                workdir,
            })
            .is_ok()
        {
            return Ok(Some(holder.conn_id));
        }
    }
    restate_send_one_way(state, "ChatRunner", &format!("{chat_id}/complete_tool"),
        json!({"call_id": call_id, "content": "Machine is offline; tool was not dispatched", "is_error": true})).await?;
    Ok(connection)
}

pub(crate) fn restore_dispatch_connection(
    state: &AppState,
    chat: Uuid,
    call: &str,
    connection: Option<Uuid>,
) {
    state
        .generations
        .set_pending_tool_connection(chat, call, connection);
}

/// A connection change makes the execution outcome unknown. Fail through the
/// durable resolver; never replay a possibly side-effecting call on a new link.
pub(crate) async fn reconcile_machine_tools(state: &AppState, machine: &str, connection: Uuid) {
    let pending = state.generations.stale_machine_calls(machine, connection);
    for (chat, call) in pending {
        let _ = restate_send_one_way(state, "ChatRunner", &format!("{chat}/complete_tool"),
            json!({"call_id": call, "content": "Machine connection changed; execution outcome is unknown. Do not retry this action without checking its effects.", "is_error": true})).await;
    }
}

/// Removes a suspended client tool call (completed or timed out).
pub(crate) fn clear_pending_tool(state: &AppState, chat_id: Uuid, call_id: &str) {
    state.generations.clear_pending_tool(chat_id, call_id);
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use crate::http::hub::Member;
    use std::time::Duration;
    use crate::http::ws::{socket_channel, SocketOutput};
    use crate::test_support::test_state_with_mock_ingress;
    use uuid::Uuid;

    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn dispatch_reservation_survives_process_state_loss_without_reexecution() {
        let (fixture, ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let chat = Uuid::now_v7();
        let original = Uuid::now_v7();
        let (sink, mut output) = crate::http::ws::socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: original,
                    user_id: Uuid::now_v7(),
                    org_id: Uuid::now_v7(),
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        fixture.state.generations.attach(chat);
        note_pending_tool(
            &fixture.state,
            chat,
            "call",
            "execute",
            "{}",
            Some("machine"),
            None,
        );
        assert_eq!(
            dispatch_pending_tool(&fixture.state, chat, "call", "durable-awakeable")
                .await
                .unwrap(),
            Some(original)
        );
        assert!(matches!(
            output.try_recv().unwrap(),
            crate::http::ws::SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch { .. })
        ));
        let restarted =
            AppState::with_store(Arc::new(fixture.store()), (*fixture.state.config).clone());
        let (sink, mut replacement_output) = crate::http::ws::socket_channel();
        restarted
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: Uuid::now_v7(),
                    user_id: Uuid::now_v7(),
                    org_id: Uuid::now_v7(),
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        restarted.generations.attach(chat);
        note_pending_tool(&restarted, chat, "call", "execute", "{}", Some("machine"), None);
        assert_eq!(
            dispatch_pending_tool(&restarted, chat, "call", "durable-awakeable")
                .await
                .unwrap(),
            Some(original)
        );
        assert!(replacement_output.try_recv().is_err());
        assert!(ingress
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(_, body)| body["is_error"] == true));
    }

    /// The dispatch frame carries the workspace folder: the executor runs
    /// the tool there (the volatile per-chat dir map is gone).
    #[tokio::test]
    async fn dispatch_carries_workdir_from_project_folder() {
        let (fixture, _ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let chat = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let (sink, mut output) = crate::http::ws::socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: conn,
                    user_id: Uuid::now_v7(),
                    org_id: Uuid::now_v7(),
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        fixture.state.generations.attach(chat);
        note_pending_tool(
            &fixture.state,
            chat,
            "call",
            "execute",
            "{}",
            Some("machine"),
            Some(r"\\wsl.localhost\Ubuntu-22.04\home\u\repo"),
        );
        dispatch_pending_tool(&fixture.state, chat, "call", "durable-awakeable")
            .await
            .unwrap();
        match output.try_recv().unwrap() {
            crate::http::ws::SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch {
                workdir,
                ..
            }) => {
                assert_eq!(
                    workdir.as_deref(),
                    Some(r"\\wsl.localhost\Ubuntu-22.04\home\u\repo")
                );
            }
            other => panic!("expected ToolDispatch, got {other:?}"),
        }
    }

    /// The dispatch workdir comes from the journaled project resolution: a
    /// chat bound to a project carries the project's folder (the resolver
    /// the ChatRunner's turn start journals, not a hand-set workdir).
    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn dispatch_workdir_follows_the_journaled_project_resolution() {
        let (fixture, _ingress) = crate::test_support::test_state_with_mock_ingress().await;
        let store = fixture.store();
        let user_id = store
            .identity()
            .ensure_bootstrap_admin("a@b.c", "hunter226")
            .await
            .unwrap();
        let user = store.identity().get_user(user_id).await.unwrap();
        let project = store
            .projects()
            .create(
                user.org_id,
                user.id,
                "repo",
                r"\\wsl.localhost\Ubuntu-22.04\home\u\repo",
                "machine",
            )
            .await
            .unwrap();
        let chat_row = store
            .chats()
            .create_chat(user.org_id, user.id, Some("t"), Some(project.id))
            .await
            .unwrap();
        let conn = Uuid::now_v7();
        let (sink, mut output) = crate::http::ws::socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                crate::http::hub::Member {
                    conn_id: conn,
                    user_id: user.id,
                    org_id: user.org_id,
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        // The journaled resolution (what the ChatRunner runs at turn start).
        let workspace = crate::worker::restate::resolve_workspace(
            &fixture.state,
            user.org_id,
            chat_row.project_id,
        )
        .await
        .unwrap()
        .expect("bound project resolves");
        assert_eq!(workspace.folder, project.folder);
        fixture.state.generations.attach(chat_row.id);
        note_pending_tool(
            &fixture.state,
            chat_row.id,
            "call",
            "execute",
            "{}",
            Some("machine"),
            Some(&workspace.folder),
        );
        dispatch_pending_tool(&fixture.state, chat_row.id, "call", "durable-awakeable")
            .await
            .unwrap();
        match output.try_recv().unwrap() {
            crate::http::ws::SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch {
                workdir,
                ..
            }) => assert_eq!(workdir.as_deref(), Some(project.folder.as_str())),
            other => panic!("expected ToolDispatch, got {other:?}"),
        }
    }
    /// A stop while the tool is suspended resolves it through the durable
    /// resolver (the interrupt notice rides the same complete_tool funnel as
    /// every other resolution), so the turn ends at the next journaled cancel
    /// check instead of waiting out the executor.
    #[tokio::test]
    async fn stop_during_suspend_resolves_the_tool_through_the_durable_resolver() {
        let (fixture, ingress) = test_state_with_mock_ingress().await;
        let chat = Uuid::now_v7();
        fixture.state.generations.attach(chat);
        let done = fixture.state.generations.set_pending_tool(
            chat,
            "call",
            PendingTool {
                name: "execute".into(),
                arguments: "{}".into(),
                machine_id: Some("m".into()),
                workdir: None,
                connection_id: None,
                done: Arc::new(tokio::sync::Notify::new()),
            },
        );
        spawn_stop_watcher(&fixture.state, chat, "call".into(), done);
        if let Some(cancel) = fixture.state.generations.cancel_flag(chat) {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if ingress
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(path, body)| {
                        path.contains("complete_tool")
                            && body["call_id"] == "call"
                            && body["is_error"] == true
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("stop resolves the suspended tool");
        let hit = ingress
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|(path, body)| path.contains("complete_tool") && body["call_id"] == "call")
            .map(|(_, body)| body["content"].as_str().unwrap_or_default().to_string())
            .unwrap_or_default();
        assert!(hit.contains("interrupted"), "got: {hit}");
    }

    /// A suspended call dispatches once to the bound machine's live
    /// connection and is removed (with its watcher signal fired) when the
    /// funnel clears it.
    #[tokio::test]
    async fn suspended_call_dispatches_and_clears_on_completion() {
        let (fixture, _ingress) = test_state_with_mock_ingress().await;
        let chat = Uuid::now_v7();
        let conn = Uuid::now_v7();
        let (sink, mut output) = socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                Member {
                    conn_id: conn,
                    user_id: Uuid::now_v7(),
                    org_id: Uuid::now_v7(),
                    sink,
                    label: None,
                },
                "machine",
            )
            .await
            .unwrap();
        fixture.state.generations.attach(chat);
        let done = note_pending_tool(
            &fixture.state,
            chat,
            "call",
            "execute",
            "{}",
            Some("machine"),
            None,
        );
        assert_eq!(
            dispatch_pending_tool(&fixture.state, chat, "call", "durable-awakeable")
                .await
                .unwrap(),
            Some(conn)
        );
        assert!(matches!(
            output.try_recv().unwrap(),
            SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch { .. })
        ));
        // Completion clears the call and fires the watcher signal.
        let notified = tokio::spawn(async move {
            done.notified().await;
        });
        tokio::task::yield_now().await;
        clear_pending_tool(&fixture.state, chat, "call");
        tokio::time::timeout(Duration::from_secs(1), notified)
            .await
            .expect("done signal fires")
            .unwrap();
        assert!(!fixture.state.generations.has_pending_tool(chat, "call"));
    }
}
