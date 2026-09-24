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
use crate::worker::exec_policy_gate;
use crate::worker::restate::{
    api_err, approval_gate, state_key, ChatRunnerClient, ToolResultPayload, ToolResultReq,
};
use guild_core::tools::Approval;
use protocol::api::{StreamEvent, ToolCall, ToolExecutor};
use restate_sdk::prelude::*;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

/// How long a machine tool may stay suspended before the journaled timeout
/// resolves it (client tools and the AGENTS.md fetch bound their own
/// shorter windows).
pub(crate) const CLIENT_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// How long an approval card may wait for a user decision before the gate
/// auto-denies.
pub(crate) const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

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
            if let Some(current_id) = current.filter(|id| Some(*id) != connection) {
                reconcile_machine_tools(&state, &machine_id, current_id).await;
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
/// The executor identity a machine dispatch is allowed to reach, captured at
/// turn start from journaled data: the turn's org, the chat's project (the
/// alias source when a re-pair re-keyed the machine id), and the machine
/// row's durable owner at turn start. Dispatch refuses any machine whose
/// current row names a different owner — a freed machine id claimed by
/// another member never receives another turn's arguments.
#[derive(Clone, Copy, Default)]
pub(crate) struct ExpectedExecutor {
    pub org_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub owner: Option<(Uuid, Uuid)>,
}

#[allow(clippy::too_many_arguments)] // call-site noise beats a param struct
pub(crate) fn note_pending_tool(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    name: &str,
    args: &str,
    machine_id: Option<&str>,
    workdir: Option<&str>,
    expected: ExpectedExecutor,
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
            org_id: expected.org_id,
            project_id: expected.project_id,
            expected_owner: expected.owner,
            done: done.clone(),
        },
    );
    done
}

/// Dispatches once inside the worker's journaled operation. The returned
/// connection identity is replayed, not the side effect itself.
/// Resolves the machine a dispatch may target. A re-pair (fingerprint
/// adoption) re-keys the registry row to a new id under the SAME owner; the
/// journaled turn id then has no row, and the project's current binding is
/// the alias — the same re-resolution rule the queued-command path applies
/// at turn start. Returns `(machine_id, durable_owner)`.
async fn resolve_dispatch_target(
    store: &crate::store::Store,
    tool: &crate::state::PendingTool,
) -> Result<(Option<String>, Option<(Uuid, Uuid)>), crate::http::error::ApiError> {
    let mut machine_id = tool.machine_id.clone();
    let mut owner = match machine_id.as_deref() {
        Some(id) => store.machines().owner_of(id).await.ok().flatten(),
        None => None,
    };
    let owner_matches = |owner: &Option<(Uuid, Uuid)>| {
        match tool.expected_owner {
            Some(expected) => owner.as_ref() == Some(&expected),
            // No captured owner (legacy journal): the org check below still
            // applies.
            None => true,
        }
    };
    if !owner_matches(&owner) {
        if let (Some(project_id), Some(org_id)) = (tool.project_id, tool.org_id) {
            let alias: Option<(Option<String>,)> =
                sqlx::query_as("SELECT machine_id FROM projects WHERE id = $1 AND org_id = $2")
                    .bind(project_id)
                    .bind(org_id)
                    .fetch_optional(store.pool())
                    .await?;
            if let Some((Some(alias),)) = alias {
                if Some(&alias) != machine_id.as_ref() {
                    let alias_owner = store.machines().owner_of(&alias).await.ok().flatten();
                    if owner_matches(&alias_owner) {
                        machine_id = Some(alias);
                        owner = alias_owner;
                    }
                }
            }
        }
    }
    Ok((machine_id, owner))
}

/// Dispatches once inside the worker's journaled operation. The returned
/// connection identity is replayed, not the side effect itself.
pub(crate) async fn dispatch_pending_tool(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    dispatch_id: &str,
) -> Result<Option<Uuid>, crate::http::error::ApiError> {
    let tool = state.generations.pending_tool(chat_id, call_id);
    let Some(tool) = tool else {
        return Ok(None);
    };
    let store = state.store().await?;
    let key = format!("tool_dispatch:{chat_id}:{dispatch_id}");

    // Executor-identity validation: the dispatch goes only to a machine
    // whose durable registry row still names the owner captured at turn
    // start (and the turn's own org). A re-pair keeps the owner and is
    // followed through the project row's re-keyed binding; a foreign claim
    // of the freed id never matches, and the call fails closed instead of
    // sending arguments and the workspace path to another member's socket.
    let (machine, owner) = resolve_dispatch_target(&store, &tool).await?;
    let holder = machine
        .as_deref()
        .and_then(|id| state.hub.machine_holder(id));
    let mut identity_ok = match (&tool.expected_owner, &owner) {
        (Some(expected), Some(current)) => expected == current,
        (Some(_), None) => false,
        // Legacy turn without a captured owner: the org boundary still holds.
        (None, owner) => match (owner, &holder) {
            (Some((_, org)), Some(member)) => *org == member.org_id,
            (Some((_, org)), None) => tool.org_id == Some(*org),
            (None, _) => true,
        },
    };
    if let (Some(member), Some((owner_user, owner_org))) = (holder.as_ref(), owner.as_ref()) {
        if member.user_id != *owner_user || member.org_id != *owner_org {
            identity_ok = false;
        }
    }
    if !identity_ok {
        restate_send_one_way(state, "ChatRunner", &format!("{chat_id}/complete_tool"),
            json!({"call_id": call_id, "content": "tool not dispatched: the bound machine's pairing changed; the executor identity no longer matches the turn", "is_error": true})).await?;
        return Ok(None);
    }

    let connection = holder.as_ref().map(|m| m.conn_id);
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
    if let Some(holder) = holder {
        if holder
            .sink
            .try_send(protocol::ws::WsServerMsg::ToolDispatch {
                chat_id,
                call_id: call_id.into(),
                name: tool.name.clone(),
                arguments: tool.arguments.clone(),
                workdir: tool.workdir.clone(),
            })
            .is_ok()
        {
            if machine != tool.machine_id {
                // The dispatch followed a re-pair to the re-keyed id: keep
                // the pending call's machine identity in step so the
                // watcher and the ownership checks track the live executor.
                state.generations.update_pending_tool_machine(
                    chat_id,
                    call_id,
                    machine,
                    Some(holder.conn_id),
                );
            }
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

/// Which executor runs the call — the taxonomy the spec promised (2026-09-18
/// unification §2.1), now a type. Adding an executor is a dispatch-shape
/// change here, never a loop change.
pub(crate) enum Executor {
    /// The chat's bound desktop machine, via the machine WS.
    Desktop {
        machine_id: String,
        machine_label: String,
        /// Workspace folder the tool runs in (from the chat's project).
        workdir: Option<String>,
        /// The executor identity dispatches are validated against.
        expected: ExpectedExecutor,
    },
    /// The per-chat server sandbox: the same gates as client tools, no hub
    /// round trip.
    Sandbox,
    /// The server itself runs the tool in the given workspace dir (the
    /// batch backend — trusted workspace, pre-approved by contract).
    ServerLocal { dir: std::path::PathBuf },
}

/// The per-chat sandbox dir (phase 5b): private to the chat, under the
/// server's data dir.
pub(crate) fn sandbox_dir(state: &AppState, chat_id: Uuid) -> std::path::PathBuf {
    std::path::Path::new(&state.config.data_dir)
        .join("sandbox")
        .join(chat_id.to_string())
}

/// Worker port of the funnel: everything between the resolved executor and
/// the journaled resolution — exec-policy gate, approval gate, then either
/// the awakeable + KV dispatch claim + watchers + durable timeout (machine
/// executor) or the journaled inline run (server-side executors). Returns
/// the payload the caller persists on the tool_result event.
// The durable tool suspension boundary carries execution and stream context.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn suspend(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &tokio::sync::broadcast::Sender<StreamEvent>,
    org_id: Uuid,
    model: &str,
    chat_id: Uuid,
    call: &ToolCall,
    executor: Executor,
) -> HandlerResult<ToolResultPayload> {
    match executor {
        Executor::ServerLocal { dir } => run_server_tool(ctx, state, tx, call, dir).await,
        Executor::Sandbox => {
            if let Some(denial) =
                exec_and_approval_gate(ctx, state, tx, org_id, model, chat_id, call).await?
            {
                return Ok(denial);
            }
            run_server_tool(ctx, state, tx, call, sandbox_dir(state, chat_id)).await
        }
        Executor::Desktop {
            machine_id,
            machine_label,
            workdir,
            expected,
        } => {
            // ---- Static exec policy (codex model): Starlark prefix rules
            // decide before the interactive gate. An `allow` rule runs the
            // command with no gate at all; a `forbidden` rule is a hard deny
            // whose text is the rule's justification (the model recovers by
            // trying a materially different command, never by escalating);
            // `prompt` rules and unmatched commands fall through to the
            // chat's approval flow below. Pure function of the compiled-in
            // rules and the command string — replay-stable.
            if let Some(denial) =
                exec_and_approval_gate(ctx, state, tx, org_id, model, chat_id, call).await?
            {
                return Ok(denial);
            }

            // Journaled awakeable: stable id across replays.
            let (awakeable_id, promise) = ctx.awakeable::<Json<ToolResultPayload>>();
            ctx.set(&state_key(&call.id), awakeable_id.clone());
            // Journaled: notify attached clients that this call must run
            // client-side.
            let args_json =
                serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string());
            let done = note_pending_tool(
                state,
                chat_id,
                &call.id,
                &call.name,
                &args_json,
                Some(&machine_id),
                workdir.as_deref(),
                expected,
            );
            let tx2 = tx.clone();
            let call_id = call.id.clone();
            let name = call.name.clone();
            let args2 = args_json.clone();
            let dispatch_state = state.clone();
            let dispatch_id = awakeable_id.clone();
            let dispatched_connection = ctx
                .run(move || {
                    let state = dispatch_state.clone();
                    let dispatch_id = dispatch_id.clone();
                    let tx = tx2.clone();
                    let call_id = call_id.clone();
                    let name = name.clone();
                    let args = args2.clone();
                    async move {
                        let connection =
                            dispatch_pending_tool(&state, chat_id, &call_id, &dispatch_id)
                                .await
                                .map_err(api_err)?;
                        let _ = tx.send(StreamEvent::ToolStarted {
                            call_id,
                            name,
                            arguments: args,
                            executor: ToolExecutor::Client,
                            kind: None,
                        });
                        Ok(Json(connection))
                    }
                })
                .await?
                .into_inner();
            restore_dispatch_connection(state, chat_id, &call.id, dispatched_connection);

            // Termination detection: if the bound machine disappears
            // (executor connection gone, app-lifetime — not per-thread
            // streams), resolve the tool with an error after a grace window
            // instead of dead-airing for the full timeout. Spawned outside
            // the journaled sections on purpose: a worker restart replays
            // this handler and re-spawns the watcher.
            spawn_machine_watcher(
                state,
                chat_id,
                call.id.clone(),
                call.name.clone(),
                machine_id,
                machine_label,
                done.clone(),
            );
            // Stop responsiveness: a stop while the tool is suspended
            // resolves it immediately (same durable funnel), so the turn
            // ends at the next journaled cancel check instead of waiting out
            // the executor.
            spawn_stop_watcher(state, chat_id, call.id.clone(), done);
            // Durable timeout: schedule a journaled delayed completion
            // instead of racing futures — a dropped ctx.sleep blocks replay
            // until the timer fires, while send_after lives in Restate's
            // timer service and never gates this workflow's journal. The
            // delayed complete_tool targets the shared handler, so it runs
            // while `generate` is suspended; when the client result arrived
            // first, complete_tool is a no-op (state cleared).
            ctx.object_client::<ChatRunnerClient>(&chat_id.to_string())
                .complete_tool(Json(ToolResultReq {
                    call_id: call.id.clone(),
                    content: format!(
                        "client tool {} ({}) timed out after 5 minutes: no client result arrived",
                        call.name, call.id
                    ),
                    is_error: true,
                    meta: None,
                    images: Vec::new(),
                }))
                .send_after(CLIENT_TOOL_TIMEOUT);

            let payload: ToolResultPayload = match promise.await {
                Ok(Json(p)) => p,
                Err(t) => ToolResultPayload {
                    content: format!("client tool failed: {t}"),
                    is_error: true,
                    meta: None,
                    images: Vec::new(),
                },
            };

            ctx.clear(&state_key(&call.id));
            clear_pending_tool(state, chat_id, &call.id);

            // Journaled: report completion to attached clients.
            let tx2 = tx.clone();
            let call_id = call.id.clone();
            let name = call.name.clone();
            let content2 = payload.content.clone();
            let is_error = payload.is_error;
            ctx.run(move || {
                let tx = tx2.clone();
                let call_id = call_id.clone();
                let name = name.clone();
                let content = content2.clone();
                async move {
                    let _ = tx.send(StreamEvent::ToolCompleted {
                        call_id,
                        name,
                        content,
                        is_error,
                    });
                    Ok(Json(()))
                }
            })
            .await?;

            Ok(payload)
        }
    }
}

/// Static exec-policy gate plus the interactive approval gate behind it: a
/// `forbidden` rule is a hard deny (its text is the rule's justification);
/// `prompt` rules and unmatched commands fall through to the chat's
/// approval flow — the client answers it like any other executor's. A
/// static allow skips the interactive gate entirely.
async fn exec_and_approval_gate(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &tokio::sync::broadcast::Sender<StreamEvent>,
    org_id: Uuid,
    model: &str,
    chat_id: Uuid,
    call: &ToolCall,
) -> HandlerResult<Option<ToolResultPayload>> {
    let static_decision = exec_policy_gate::evaluate_execute(&call.arguments);
    if let exec_policy_gate::ExecPolicyDecision::Deny(reason) = &static_decision {
        return Ok(Some(ToolResultPayload {
            content: format!("denied by exec policy: {reason}"),
            is_error: true,
            meta: None,
            images: Vec::new(),
        }));
    }
    if !matches!(static_decision, exec_policy_gate::ExecPolicyDecision::Allow) {
        // ---- Approval gate (phase 2, design §C). Journaled
        // request/decision flow; denial is a normal tool_result payload the
        // caller persists.
        if let Some(denial) = approval_gate(
            ctx,
            state,
            tx,
            org_id,
            model,
            chat_id,
            call,
            Approval::Ask,
            false,
        )
        .await?
        {
            return Ok(Some(denial));
        }
    }
    Ok(None)
}

/// One server-side tool call: the server executes the client-tool in-process
/// against the given workspace dir — journaled side effect (the result
/// replays without re-running), then notifies attached clients exactly like
/// the machine dispatch does. No interactive approvals here (the batch
/// contract is "trusted workspace, pre-approved"; the sandbox caller runs
/// its gates before dispatching); `execute` still passes the static
/// exec-policy gate, and shell tools require the server allowlist flag.
async fn run_server_tool(
    ctx: &ObjectContext<'_>,
    state: &AppState,
    tx: &tokio::sync::broadcast::Sender<StreamEvent>,
    call: &ToolCall,
    dir: std::path::PathBuf,
) -> HandlerResult<ToolResultPayload> {
    let args_json = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string());
    // Journaled: notify attached clients that this call runs server-side.
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name = call.name.clone();
    let args2 = args_json.clone();
    ctx.run(move || {
        let tx = tx2.clone();
        let call_id = call_id.clone();
        let name = name.clone();
        let args = args2.clone();
        async move {
            let _ = tx.send(StreamEvent::ToolStarted {
                call_id,
                name,
                arguments: args,
                executor: ToolExecutor::Server,
                kind: None,
            });
            Ok(Json(()))
        }
    })
    .await?;

    let shell_allowed = state.config.allow_shell_tools;
    let name = call.name.clone();
    let args = call.arguments.clone();
    let effect_key = format!("server_effect:{}:{}", ctx.invocation_id(), call.id);
    let st = state.clone();
    let payload: ToolResultPayload = ctx
        .run(move || {
            let dir = dir.clone();
            let name = name.clone();
            let args = args.clone();
            let state = st.clone();
            let effect_key = effect_key.clone();
            async move {
                let guarded = name != "read_file";
                let store = state.store().await.map_err(api_err)?;
                if name == "execute" && !shell_allowed {
                    return Ok(Json(ToolResultPayload {
                        content: "denied: shell tools are disabled on this server".into(),
                        is_error: true,
                        meta: None,
                        images: Vec::new(),
                    }));
                }
                if name == "execute" {
                    if let exec_policy_gate::ExecPolicyDecision::Deny(reason) =
                        exec_policy_gate::evaluate_execute(&args)
                    {
                        return Ok(Json(ToolResultPayload {
                            content: format!("denied by exec policy: {reason}"),
                            is_error: true,
                            meta: None,
                            images: Vec::new(),
                        }));
                    }
                }
                if guarded {
                    match crate::worker::effects::claim(&store, &effect_key).await? {
                        crate::worker::effects::Claim::Execute => {},
                        crate::worker::effects::Claim::Completed(result) => return Ok(Json(result)),
                        crate::worker::effects::Claim::Unknown => return Ok(Json(ToolResultPayload {
                            content: "Execution outcome is unknown after interruption; check effects before retrying this action.".into(),
                            is_error: true, meta: None, images: Vec::new(),
                        })),
                    }
                }
                tokio::fs::create_dir_all(&dir)
                    .await
                    .map_err(|e| anyhow::anyhow!("workspace dir: {e}"))?;
                let mut registry = guild_core::tools::ToolRegistry::new();
                registry.add(Arc::new(guild_core::tools::fs::ReadFile::default()));
                registry.add(Arc::new(guild_core::tools::fs::WriteFile));
                registry.add(Arc::new(guild_core::tools::fs::EditFile));
                if shell_allowed {
                    registry.add(Arc::new(guild_core::tools::shell::RunCommand));
                }
                let payload = match registry.get(&name) {
                    Some(tool) => match tool.run(std::path::Path::new(&dir), args).await {
                        Ok(out) => ToolResultPayload {
                            content: out.output_for_model,
                            is_error: false,
                            meta: out.meta,
                            images: out.images,
                        },
                        Err(e) => ToolResultPayload {
                            content: e.to_string(),
                            is_error: true,
                            meta: None,
                            images: Vec::new(),
                        },
                    },
                    None => ToolResultPayload {
                        content: format!("unknown tool {name}"),
                        is_error: true,
                        meta: None,
                        images: Vec::new(),
                    },
                };
                if guarded {
                    crate::worker::effects::complete(&store, &effect_key, &payload).await?;
                }
                Ok(Json(payload))
            }
        })
        .await?
        .into_inner();

    // Journaled: report completion.
    let tx2 = tx.clone();
    let call_id = call.id.clone();
    let name2 = call.name.clone();
    let content2 = payload.content.clone();
    let is_error = payload.is_error;
    ctx.run(move || {
        let tx = tx2.clone();
        let call_id = call_id.clone();
        let name = name2.clone();
        let content = content2.clone();
        async move {
            let _ = tx.send(StreamEvent::ToolCompleted {
                call_id,
                name,
                content,
                is_error,
            });
            Ok(Json(()))
        }
    })
    .await?;

    Ok(payload)
}

/// One-way forward of an approval decision to the ChatRunner's
/// `complete_approval` awakeable resolver (the resolve side of the approval
/// gate: user decisions from any client, the auto-deny timer, and the
/// orphaned-call expiry marker all ride this).
pub(crate) async fn forward_approval_decision(
    state: &AppState,
    chat_id: Uuid,
    call_id: &str,
    approved: bool,
    reason: Option<String>,
) -> Result<String, crate::http::error::ApiError> {
    restate_send_one_way(
        state,
        "ChatRunner",
        &format!("{chat_id}/complete_approval"),
        serde_json::to_value(crate::worker::restate::ApprovalReq {
            call_id: call_id.to_string(),
            approved,
            reason,
        })
        .expect("approval request serializes"),
    )
    .await
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use crate::http::hub::Member;
    use crate::http::ws::{socket_channel, SocketOutput};
    use crate::test_support::test_state_with_mock_ingress;
    use std::time::Duration;
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
            Default::default(),
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
        note_pending_tool(
            &restarted,
            chat,
            "call",
            "execute",
            "{}",
            Some("machine"),
            None,
            Default::default(),
        );
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
            Default::default(),
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
        store
            .machines()
            .upsert_connected(
                user.org_id,
                user.id,
                "machine",
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
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
            Default::default(),
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
                org_id: None,
                project_id: None,
                expected_owner: None,
                done: Arc::new(tokio::sync::Notify::new()),
            },
        );
        spawn_stop_watcher(&fixture.state, chat, "call".into(), done);
        if let Some(cancel) = fixture.state.generations.cancel_flag(chat) {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if ingress.requests.lock().unwrap().iter().any(|(path, body)| {
                    path.contains("complete_tool")
                        && body["call_id"] == "call"
                        && body["is_error"] == true
                }) {
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
            Default::default(),
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

    /// A machine id freed by a re-pair and claimed by another member never
    /// receives another turn's dispatch: the executor identity captured at
    /// turn start no longer matches the reclaimed row's owner, so the call
    /// fails closed instead of sending arguments and the workspace path to
    /// the claimant's socket.
    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn reclaimed_machine_id_never_receives_dispatches() {
        let (fixture, ingress) = test_state_with_mock_ingress().await;
        let store = fixture.store();
        let admin = store
            .identity()
            .ensure_bootstrap_admin("a@b.c", "hunter226")
            .await
            .unwrap();
        let a = store.identity().get_user(admin).await.unwrap();
        let b = store
            .identity()
            .create_user(a.org_id, "b@b.c", "hunter226", "member")
            .await
            .unwrap();
        store
            .machines()
            .upsert_connected(a.org_id, a.id, "m", None, None, None, None, None, None)
            .await
            .unwrap();
        let conn_a = Uuid::now_v7();
        let (sink_a, _out_a) = socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                Member {
                    conn_id: conn_a,
                    user_id: a.id,
                    org_id: a.org_id,
                    sink: sink_a,
                    label: None,
                },
                "m",
            )
            .await
            .unwrap();
        let chat = Uuid::now_v7();
        fixture.state.generations.attach(chat);
        let expected = ExpectedExecutor {
            org_id: Some(a.org_id),
            project_id: None,
            owner: Some((a.id, a.org_id)),
        };
        note_pending_tool(
            &fixture.state,
            chat,
            "call1",
            "execute",
            "{}",
            Some("m"),
            None,
            expected,
        );
        assert_eq!(
            dispatch_pending_tool(&fixture.state, chat, "call1", "d1")
                .await
                .unwrap(),
            Some(conn_a)
        );

        // A re-pairs away from the id (the row is re-keyed, so "m" has no
        // registry row) and member B claims the freed id.
        fixture.state.hub.unregister_machine("m", conn_a);
        sqlx::query("DELETE FROM machines WHERE machine_id = 'm'")
            .execute(store.pool())
            .await
            .unwrap();
        let conn_b = Uuid::now_v7();
        let (sink_b, mut out_b) = socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                Member {
                    conn_id: conn_b,
                    user_id: b.id,
                    org_id: a.org_id,
                    sink: sink_b,
                    label: None,
                },
                "m",
            )
            .await
            .unwrap();
        note_pending_tool(
            &fixture.state,
            chat,
            "call2",
            "execute",
            "{\"cmd\":\"secret\"}",
            Some("m"),
            None,
            expected,
        );
        assert_eq!(
            dispatch_pending_tool(&fixture.state, chat, "call2", "d2")
                .await
                .unwrap(),
            None
        );
        assert!(
            out_b.try_recv().is_err(),
            "no dispatch reaches the claimant"
        );
        assert!(ingress
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(_, body)| { body["call_id"] == "call2" && body["is_error"] == true }));
    }

    /// A re-pair (fingerprint adoption) re-keys the registry row to a new id
    /// under the same owner: the active turn's dispatch follows the project
    /// row's re-keyed binding and executes on the re-paired connection.
    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn dispatch_follows_a_repair_to_the_rekeyed_id() {
        let (fixture, _ingress) = test_state_with_mock_ingress().await;
        let store = fixture.store();
        let admin = store
            .identity()
            .ensure_bootstrap_admin("a@b.c", "hunter226")
            .await
            .unwrap();
        let a = store.identity().get_user(admin).await.unwrap();
        store
            .machines()
            .upsert_connected(
                a.org_id,
                a.id,
                "old",
                None,
                Some("fp-1"),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let project = store
            .projects()
            .create(a.org_id, a.id, "repo", r"C:\\code\\repo", "old")
            .await
            .unwrap();
        // The re-pair: same fingerprint, new pairing identity — the row is
        // re-keyed to "new".
        store
            .machines()
            .upsert_connected(
                a.org_id,
                a.id,
                "new",
                Some("new-box"),
                Some("fp-1"),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let conn_new = Uuid::now_v7();
        let (sink_new, mut out_new) = socket_channel();
        fixture
            .state
            .hub
            .register_machine(
                Member {
                    conn_id: conn_new,
                    user_id: a.id,
                    org_id: a.org_id,
                    sink: sink_new,
                    label: None,
                },
                "new",
            )
            .await
            .unwrap();
        let chat = Uuid::now_v7();
        fixture.state.generations.attach(chat);
        note_pending_tool(
            &fixture.state,
            chat,
            "call1",
            "execute",
            "{}",
            Some("old"),
            Some(r"C:\\code\\repo"),
            ExpectedExecutor {
                org_id: Some(a.org_id),
                project_id: Some(project.id),
                owner: Some((a.id, a.org_id)),
            },
        );
        assert_eq!(
            dispatch_pending_tool(&fixture.state, chat, "call1", "d1")
                .await
                .unwrap(),
            Some(conn_new)
        );
        assert!(matches!(
            out_new.try_recv().unwrap(),
            SocketOutput::Message(protocol::ws::WsServerMsg::ToolDispatch { .. })
        ));
    }
}
