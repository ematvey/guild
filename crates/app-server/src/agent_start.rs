//! The `agent.start` shim (unification spec §4 phase 1): the daemon no
//! longer runs its own agent loop. It validates the request, creates or
//! attaches the cloud chat and its machine-bound project, drives the same
//! durable gateway workflow every other client uses, and maps the
//! workflow's `StreamEvent`s onto the engine protocol's `agent.*` events.
//! Approvals ride the server journal: auto policies resolve over the
//! approvals endpoint immediately, Ask waits for `agent.approve`.

use crate::agent_session::PendingApprovals;
use crate::cloud::{CloudClient, CloudError};
use futures::{Stream, StreamExt};
use guild_core::agent::policy::ApprovalPolicy;
use guild_core::tools::Approval;
use protocol::api::{CreateProjectRequest, Project, StreamEvent};
use protocol::rpc::Event;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::broadcast;
use uuid::Uuid;

/// How long an Ask approval waits for the engine client's decision before
/// denying (the same bound the in-process loop applied; the server journal
/// has its own expiry on top).
const APPROVAL_WAIT: Duration = Duration::from_secs(5 * 60);

/// Maps one workflow frame onto engine events. `text` accumulates the
/// assistant's visible text (the `agent.done` summary). Approval frames are
/// handled by [`drive`], not here.
pub(crate) fn map_frame(frame: &StreamEvent, text: &mut String) -> Vec<(&'static str, Value)> {
    match frame {
        StreamEvent::Delta { content } => {
            text.push_str(content);
            vec![("agent.text", json!({ "content": content }))]
        }
        StreamEvent::ToolStarted {
            call_id,
            name,
            arguments,
            ..
        } => vec![(
            "agent.tool_call",
            json!({ "id": call_id, "name": name, "arguments": arguments }),
        )],
        StreamEvent::ToolCompleted {
            call_id,
            name,
            content,
            is_error,
        } => {
            let payload = if *is_error {
                json!({ "id": call_id, "name": name, "error": content })
            } else {
                json!({ "id": call_id, "name": name, "output": content })
            };
            vec![("agent.tool_result", payload)]
        }
        StreamEvent::Done {
            message_id,
            cost_usd,
            tokens_in,
            tokens_out,
        } => vec![(
            "agent.done",
            json!({
                "summary": text,
                "message_id": message_id,
                "cost_usd": cost_usd,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
            }),
        )],
        StreamEvent::Error { message, .. } => {
            vec![("agent.error", json!({ "message": message }))]
        }
        // Reasoning fragments (the engine protocol has no reasoning event),
        // argument deltas (the full call arrives via ToolStarted), the
        // attach idle marker, and approval frames (drive's business).
        StreamEvent::ThinkingDelta { .. }
        | StreamEvent::ToolCallDelta { .. }
        | StreamEvent::ToolCallDone { .. }
        | StreamEvent::Idle
        | StreamEvent::ApprovalRequested { .. }
        | StreamEvent::ApprovalResolved { .. } => Vec::new(),
    }
}

/// Consumes the workflow's frame stream, emits engine events on the
/// session's broadcast channel, and resolves approvals (auto by policy,
/// else via the pending map — `agent.approve` resolves the oneshot and this
/// posts the decision to the approvals endpoint). Returns when the stream
/// ends (Done/Error terminate it upstream).
pub(crate) async fn drive(
    cloud: CloudClient,
    chat_id: Uuid,
    policy: ApprovalPolicy,
    pending: PendingApprovals,
    events: broadcast::Sender<Value>,
    stream: impl Stream<Item = Result<StreamEvent, CloudError>>,
) -> Result<(), CloudError> {
    let mut stream = std::pin::pin!(stream);
    let mut text = String::new();
    while let Some(item) = stream.next().await {
        let frame = item?;
        if let StreamEvent::ApprovalRequested {
            call_id,
            name,
            arguments,
        } = &frame
        {
            resolve_approval(
                &cloud,
                chat_id,
                &policy,
                &pending,
                &events,
                call_id,
                name,
                arguments,
            )
            .await;
            continue;
        }
        for (event, payload) in map_frame(&frame, &mut text) {
            let _ = events.send(
                serde_json::to_value(Event::new(event, payload)).expect("event serializes"),
            );
        }
    }
    Ok(())
}

/// Resolves one ApprovalRequested frame: policy auto-decides (Allow/Never)
/// or the engine client does (Ask: emit the request, wait on the pending
/// oneshot `agent.approve` resolves). The decision posts to the approvals
/// endpoint; a failed post is logged, not fatal (the journal expiry bounds
/// the wait server-side anyway).
async fn resolve_approval(
    cloud: &CloudClient,
    chat_id: Uuid,
    policy: &ApprovalPolicy,
    pending: &PendingApprovals,
    events: &broadcast::Sender<Value>,
    call_id: &str,
    name: &str,
    arguments: &str,
) {
    let (approved, reason) = match policy.for_tool(name, Approval::Ask) {
        Approval::Allow => (true, None),
        Approval::Never => (false, Some("denied by policy".to_string())),
        Approval::Ask => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            pending
                .lock()
                .unwrap()
                .insert(call_id.to_string(), tx);
            let _ = events.send(
                serde_json::to_value(Event::new(
                    "agent.approval_request",
                    json!({ "request_id": call_id, "tool": name, "arguments": arguments }),
                ))
                .expect("event serializes"),
            );
            match tokio::time::timeout(APPROVAL_WAIT, rx).await {
                Ok(Ok(guild_core::agent::ApprovalDecision::Approve)) => (true, None),
                Ok(Ok(guild_core::agent::ApprovalDecision::Deny { reason })) => (false, Some(reason)),
                // Sender dropped (session closed) or timed out — deny so the
                // turn proceeds; drop the dead entry.
                Ok(Err(_)) | Err(_) => {
                    pending.lock().unwrap().remove(call_id);
                    (false, Some("no approval decision in time".to_string()))
                }
            }
        }
    };
    if let Err(e) = cloud
        .resolve_approval(chat_id, call_id, approved, reason.as_deref())
        .await
    {
        crate::dtrace::dtrace(&format!(
            "approval post failed (chat {chat_id}, call {call_id}): {e}"
        ));
    }
}

/// Finds the project for `folder` or creates one bound to `machine_id` —
/// the workflow dispatches the turn's tools to the machine the project is
/// bound to, which must be this daemon's own executor link. A folder bound
/// to another machine is an error, never a silent rebind.
pub(crate) async fn ensure_project(
    cloud: &CloudClient,
    folder: &str,
    machine_id: &str,
) -> anyhow::Result<Project> {
    for project in cloud.list_projects().await? {
        if project.folder == folder {
            anyhow::ensure!(
                project.machine_id == machine_id,
                "project `{}` is bound to machine `{}`; this machine is `{}` — run it there or rebind the project",
                project.name,
                project.machine_id,
                machine_id
            );
            return Ok(project);
        }
    }
    let name = std::path::Path::new(folder)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_string());
    // The machine's executor link registers its server record on WS connect,
    // which lags an identify that arrives right after daemon start — retry
    // the create briefly before giving up.
    let req = CreateProjectRequest {
        name: Some(name),
        folder: folder.to_string(),
        machine_id: machine_id.to_string(),
    };
    for attempt in 0..5 {
        match cloud.create_project(&req).await {
            Ok(p) => return Ok(p),
            Err(e) if attempt < 4 && e.to_string().contains("unknown machine") => {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!("retry loop returns")
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;

    fn collect(frames: &[StreamEvent]) -> Vec<(String, Value)> {
        let mut text = String::new();
        frames
            .iter()
            .flat_map(|f| map_frame(f, &mut text))
            .map(|(e, v)| (e.to_string(), v))
            .collect()
    }

    #[test]
    fn deltas_map_to_text_and_accumulate_the_done_summary() {
        let frames = vec![
            StreamEvent::Delta {
                content: "hel".into(),
            },
            StreamEvent::Delta {
                content: "lo".into(),
            },
            StreamEvent::Done {
                message_id: Uuid::now_v7(),
                cost_usd: 0.01,
                tokens_in: 5,
                tokens_out: 2,
            },
        ];
        let events = collect(&frames);
        assert_eq!(events[0].0, "agent.text");
        assert_eq!(events[0].1["content"], "hel");
        assert_eq!(events[1].1["content"], "lo");
        assert_eq!(events[2].0, "agent.done");
        assert_eq!(events[2].1["summary"], "hello");
        assert_eq!(events[2].1["tokens_in"], 5);
    }

    #[test]
    fn tool_frames_map_with_the_old_engine_shapes() {
        let frames = vec![
            StreamEvent::ToolStarted {
                call_id: "c1".into(),
                name: "execute".into(),
                arguments: r#"{"command":"ls"}"#.into(),
                executor: protocol::api::ToolExecutor::Client,
                kind: None,
            },
            StreamEvent::ToolCompleted {
                call_id: "c1".into(),
                name: "execute".into(),
                content: "ok".into(),
                is_error: false,
            },
            StreamEvent::ToolCompleted {
                call_id: "c2".into(),
                name: "execute".into(),
                content: "boom".into(),
                is_error: true,
            },
        ];
        let events = collect(&frames);
        assert_eq!(events[0].0, "agent.tool_call");
        assert_eq!(events[0].1["id"], "c1");
        assert_eq!(events[0].1["arguments"], r#"{"command":"ls"}"#);
        assert_eq!(events[1].0, "agent.tool_result");
        assert_eq!(events[1].1["output"], "ok");
        assert_eq!(events[2].1["error"], "boom");
        assert!(events[2].1.get("output").is_none());
    }

    #[test]
    fn non_engine_frames_map_to_nothing() {
        let frames = vec![
            StreamEvent::ThinkingDelta { content: "hmm".into() },
            StreamEvent::ToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments_delta: "{\"a\"".into(),
            },
            StreamEvent::ToolCallDone {
                call: protocol::api::ToolCall {
                    id: "c".into(),
                    name: "n".into(),
                    arguments: "{}".into(),
                },
            },
            StreamEvent::Idle,
        ];
        assert!(collect(&frames).is_empty());
    }

    /// The drive loop: events broadcast in order, Ask approvals wait for
    /// the pending oneshot (`agent.approve`'s surface), auto policies post
    /// without an event, and the resolved decision reaches the approvals
    /// endpoint.
    #[tokio::test]
    async fn drive_maps_frames_and_resolves_approvals() {
        let frames: Vec<Result<StreamEvent, CloudError>> = vec![
            Ok(StreamEvent::Delta { content: "hi".into() }),
            Ok(StreamEvent::ApprovalRequested {
                call_id: "ask1".into(),
                name: "execute".into(),
                arguments: "{}".into(),
            }),
            Ok(StreamEvent::ApprovalRequested {
                call_id: "auto1".into(),
                name: "read_file".into(),
                arguments: "{}".into(),
            }),
            Ok(StreamEvent::Done {
                message_id: Uuid::now_v7(),
                cost_usd: 0.0,
                tokens_in: 1,
                tokens_out: 1,
            }),
        ];
        // Approval endpoint: record decisions; both calls must land.
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let server = wiremock::MockServer::start().await;
        let seen = calls.clone();
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(move |_req: &wiremock::Request| {
                let body: Value =
                    serde_json::from_slice(&_req.body.as_slice()).unwrap_or(Value::Null);
                seen.lock().unwrap().push(body);
                wiremock::ResponseTemplate::new(200).set_body_json(json!({"ok": true}))
            })
            .mount(&server)
            .await;
        let cloud = CloudClient {
            base_url: server.uri(),
            token: "t".into(),
        };
        let (events_tx, mut events_rx) = broadcast::channel(64);
        let pending: PendingApprovals = std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        ));

        // The engine client approves "ask1" once it sees the request —
        // exactly what the agent.approve handler does.
        let resolver_pending = pending.clone();
        let resolver = tokio::spawn(async move {
            for _ in 0..200 {
                if let Some(tx) = resolver_pending.lock().unwrap().remove("ask1") {
                    let _ = tx.send(guild_core::agent::ApprovalDecision::Approve);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no approval request seen");
        });

        let mut policy = ApprovalPolicy::default();
        policy.overrides.insert("read_file".into(), Approval::Allow);

        drive(
            cloud,
            Uuid::now_v7(),
            policy,
            pending,
            events_tx,
            stream::iter(frames),
        )
        .await
        .unwrap();
        resolver.await.unwrap();

        let mut got = Vec::new();
        while let Ok(v) = events_rx.try_recv() {
            got.push(v["event"].as_str().unwrap().to_string());
        }
        assert_eq!(
            got,
            vec!["agent.text", "agent.approval_request", "agent.done"]
        );
        let decisions = calls.lock().unwrap().clone();
        assert_eq!(decisions.len(), 2, "{decisions:?}");
        assert_eq!(decisions[0]["approved"], true, "ask1 approved by the engine");
        assert_eq!(decisions[1]["approved"], true, "auto policy: read_file");
    }

    /// ensure_project: an existing folder bound to this machine passes
    /// through, a foreign-machine binding is an error, a new folder is
    /// created against the machine id.
    #[tokio::test]
    async fn ensure_project_binds_new_folders_and_rejects_foreign_machines() {
        let machine = std::sync::Arc::new(uuid::Uuid::now_v7().to_string());
        let server = wiremock::MockServer::start().await;
        let listed = machine.clone();
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/api/v1/projects"))
            .respond_with(move |_: &wiremock::Request| {
                wiremock::ResponseTemplate::new(200).set_body_json(json!({ "projects": [
                    { "id": Uuid::now_v7(), "name": "other", "folder": "/other",
                      "machine_id": format!("not-{}", *listed), "machine_label": null,
                      "created_at": "2026-01-01T00:00:00Z" }
                ]}))
            })
            .mount(&server)
            .await;
        let posts = std::sync::Arc::new(std::sync::Mutex::new(0));
        let seen = posts.clone();
        let posted = machine.clone();
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/projects"))
            .respond_with(move |req: &wiremock::Request| {
                *seen.lock().unwrap() += 1;
                let body: Value =
                    serde_json::from_slice(&req.body.as_slice()).unwrap_or(Value::Null);
                assert_eq!(body["machine_id"], *posted, "created bound to this machine");
                wiremock::ResponseTemplate::new(200).set_body_json(json!({
                    "id": Uuid::now_v7(), "name": body["name"].clone(), "folder": body["folder"].clone(),
                    "machine_id": body["machine_id"].clone(), "machine_label": null,
                    "created_at": "2026-01-01T00:00:00Z"
                }))
            })
            .mount(&server)
            .await;
        let cloud = CloudClient {
            base_url: server.uri(),
            token: "t".into(),
        };

        // New folder → created, bound to this machine.
        let created = ensure_project(&cloud, "/new/folder", &machine).await.unwrap();
        assert_eq!(created.folder, "/new/folder");
        assert_eq!(*posts.lock().unwrap(), 1);

        // Foreign machine → error, no create.
        let err = ensure_project(&cloud, "/other", &machine).await.unwrap_err();
        assert!(err.to_string().contains("bound to machine"), "{err}");
        assert_eq!(*posts.lock().unwrap(), 1);
    }
}
