//! Per-client WebSocket endpoint (spec §1): single-use ticket auth, one
//! upgrade route, per-user socket caps live in the Hub (Task 3). Browsers
//! cannot send headers on upgrade, and long-lived tokens in a query string
//! leak into access logs — hence the ticket hop over the normal
//! authenticated HTTP session.

use crate::http::auth::AuthUser;
use crate::http::feed;
use crate::http::hub::Member;
use crate::state::AppState;
use axum::{
    extract::{Query, State, WebSocketUpgrade},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use protocol::ws::{WsClientMsg, WsServerMsg};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

/// Single-use, short-TTL connect tickets. They are in-memory because tickets
/// are worthless after a restart; clients mint a fresh one on every connect.
#[derive(Clone, Default)]
pub struct TicketStore {
    tickets: Arc<Mutex<HashMap<String, (AuthUser, std::time::Instant)>>>,
}

impl TicketStore {
    const TTL: std::time::Duration = std::time::Duration::from_secs(30);

    pub fn mint(&self, user: AuthUser) -> String {
        let mut tickets = self.tickets.lock().unwrap();
        tickets.retain(|_, (_, at)| at.elapsed() < Self::TTL);
        let ticket = format!("gst_{}", Uuid::now_v7().simple());
        tickets.insert(ticket.clone(), (user, std::time::Instant::now()));
        ticket
    }

    pub fn consume(&self, ticket: &str) -> Option<AuthUser> {
        let mut tickets = self.tickets.lock().unwrap();
        let (user, at) = tickets.remove(ticket)?;
        (at.elapsed() < Self::TTL).then_some(user)
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/ws/ticket", axum::routing::post(mint_ticket))
        .route("/api/v1/ws", axum::routing::get(upgrade))
}

async fn mint_ticket(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, crate::http::error::ApiError> {
    let ticket = state.ws_tickets.mint(user);
    Ok(Json(json!({ "ticket": ticket })))
}

/// Upgrade query: `?ticket=<single-use>&client_id=<stable browser id>&machine_id=<opt>&machine_name=<opt>`.
/// `client_id` identifies the browser across tabs (member identity);
/// `machine_id` (desktop only) claims the machine's singleton slot.
#[derive(serde::Deserialize)]
pub struct UpgradeQuery {
    ticket: String,
    client_id: Option<String>,
    machine_id: Option<String>,
    machine_name: Option<String>,
}

async fn upgrade(
    State(state): State<AppState>,
    Query(q): Query<UpgradeQuery>,
    ws: WebSocketUpgrade,
) -> Result<axum::response::Response, crate::http::error::ApiError> {
    let user = state
        .ws_tickets
        .consume(&q.ticket)
        .ok_or_else(|| crate::http::error::ApiError::unauthorized("invalid or expired ticket"))?;
    let (tx, rx) = socket_channel(256);
    let machine_id = q.machine_id.filter(|s| !s.is_empty());
    let client_id = q.client_id.unwrap_or_else(|| Uuid::now_v7().to_string());
    let machine_name = q.machine_name;
    Ok(ws.on_upgrade(move |socket| async move {
        drive_socket(
            state,
            user,
            client_id,
            machine_id,
            machine_name,
            socket,
            tx,
            rx,
        )
        .await;
    }))
}

#[derive(Debug)]
pub(crate) enum SocketOutput {
    Message(WsServerMsg),
    SyncStart,
    SyncAbort,
    Pong(axum::body::Bytes),
}

/// The one outbound queue consumed by a socket's writer task.
#[derive(Clone)]
pub struct SocketSink {
    tx: mpsc::Sender<SocketOutput>,
    /// Serializes queue insertion across every clone. We reserve queue space
    /// before taking this synchronous mutex, never hold it across `.await`,
    /// and enqueue the sync marker under the same lock as feed output.
    ordering: Arc<Mutex<()>>,
}

impl SocketSink {
    async fn enqueue(
        &self,
        output: SocketOutput,
    ) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        let permit = match self.tx.reserve().await {
            Ok(permit) => permit,
            Err(_) => return Err(mpsc::error::SendError(output)),
        };
        let _ordering = self.ordering.lock().unwrap();
        permit.send(output);
        Ok(())
    }

    pub(crate) async fn send(
        &self,
        message: WsServerMsg,
    ) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        self.enqueue(SocketOutput::Message(message)).await
    }

    pub(crate) fn try_send(
        &self,
        message: WsServerMsg,
    ) -> Result<(), mpsc::error::TrySendError<SocketOutput>> {
        let _ordering = self.ordering.lock().unwrap();
        self.tx.try_send(SocketOutput::Message(message))
    }

    pub(crate) async fn start_sync(&self) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        self.enqueue(SocketOutput::SyncStart).await
    }

    pub(crate) async fn abort_sync(&self) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        self.enqueue(SocketOutput::SyncAbort).await
    }

    async fn pong(
        &self,
        payload: axum::body::Bytes,
    ) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        self.enqueue(SocketOutput::Pong(payload)).await
    }
}

pub(crate) fn socket_channel(capacity: usize) -> (SocketSink, mpsc::Receiver<SocketOutput>) {
    let (tx, rx) = mpsc::channel(capacity);
    (
        SocketSink {
            tx,
            ordering: Arc::new(Mutex::new(())),
        },
        rx,
    )
}

/// Holds live feed messages while one or more state-sync brackets are open.
#[derive(Default)]
pub(crate) struct SocketGate {
    sync_depth: usize,
    deferred: VecDeque<WsServerMsg>,
}

impl SocketGate {
    fn is_live(message: &WsServerMsg) -> bool {
        matches!(
            message,
            WsServerMsg::LiveFrame { .. }
                | WsServerMsg::ChatStatus { .. }
                | WsServerMsg::OrgEvent { .. }
                | WsServerMsg::Error { .. }
        )
    }

    pub(crate) fn push(&mut self, output: SocketOutput) -> Vec<WsServerMsg> {
        match output {
            SocketOutput::SyncStart => {
                self.sync_depth += 1;
                Vec::new()
            }
            SocketOutput::SyncAbort => {
                self.sync_depth = self.sync_depth.saturating_sub(1);
                self.flush_if_ready()
            }
            SocketOutput::Message(message) if self.sync_depth > 0 && Self::is_live(&message) => {
                self.deferred.push_back(message);
                Vec::new()
            }
            SocketOutput::Message(message) => {
                let done = matches!(message, WsServerMsg::SyncDone { .. });
                let mut out = vec![message];
                if done {
                    self.sync_depth = self.sync_depth.saturating_sub(1);
                    out.extend(self.flush_if_ready());
                }
                out
            }
            SocketOutput::Pong(_) => Vec::new(),
        }
    }

    fn flush_if_ready(&mut self) -> Vec<WsServerMsg> {
        if self.sync_depth == 0 {
            self.deferred.drain(..).collect()
        } else {
            Vec::new()
        }
    }
}

pub(crate) async fn drive_socket(
    state: AppState,
    user: AuthUser,
    _client_id: String,
    machine_id: Option<String>,
    machine_name: Option<String>,
    socket: axum::extract::ws::WebSocket,
    tx: SocketSink,
    mut rx: mpsc::Receiver<SocketOutput>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let conn_id = Uuid::now_v7();
    let member = Member {
        conn_id,
        user_id: user.0.id,
        org_id: user.0.org_id,
        sink: tx.clone(),
        label: machine_name,
    };

    let mut machine_shutdown = match machine_id.as_deref() {
        Some(machine_id) => match state.hub.register_machine(member.clone(), machine_id) {
            Ok(registration) => Some(registration.shutdown),
            Err(crate::http::hub::CapRejected) => {
                let _ = ws_tx
                    .send(axum::extract::ws::Message::text(
                        serde_json::to_string(&WsServerMsg::Error {
                            message: "too many connections".into(),
                        })
                        .unwrap(),
                    ))
                    .await;
                return;
            }
        },
        None => {
            if state.hub.register_member(member.clone()).is_err() {
                let _ = ws_tx
                    .send(axum::extract::ws::Message::text(
                        serde_json::to_string(&WsServerMsg::Error {
                            message: "too many connections".into(),
                        })
                        .unwrap(),
                    ))
                    .await;
                return;
            }
            None
        }
    };

    let (writer_done_tx, mut writer_done_rx) = oneshot::channel();
    let writer = tokio::spawn(async move {
        let mut gate = SocketGate::default();
        while let Some(output) = rx.recv().await {
            if let SocketOutput::Pong(payload) = output {
                if ws_tx
                    .send(axum::extract::ws::Message::Pong(payload))
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
            for message in gate.push(output) {
                let displaced = matches!(message, WsServerMsg::Displaced);
                let text = serde_json::to_string(&message).expect("server message serializes");
                if ws_tx
                    .send(axum::extract::ws::Message::text(text))
                    .await
                    .is_err()
                    || displaced
                {
                    let _ = writer_done_tx.send(());
                    return;
                }
            }
        }
        let _ = writer_done_tx.send(());
    });

    let _ = member.sink.send(WsServerMsg::Hello).await;
    match feed::thread_list(&state, &user).await {
        Ok(chats) => {
            let _ = member.sink.send(WsServerMsg::ThreadList { chats }).await;
        }
        Err(error) => {
            let _ = member
                .sink
                .send(WsServerMsg::Error {
                    message: error.message,
                })
                .await;
        }
    }
    let feed_forwarder = feed::forward_to_socket(feed::feed_of(&state, &user), member.sink.clone());
    let (client_tx, mut client_rx) = mpsc::channel(32);
    let client_state = state.clone();
    let client_user = AuthUser(user.0.clone());
    let client_member = member.clone();
    let client_task = tokio::spawn(async move {
        while let Some(message) = client_rx.recv().await {
            handle_client_msg(&client_state, &client_user, &client_member, message).await;
        }
    });

    loop {
        tokio::select! {
            _ = async {
                match machine_shutdown.as_mut() {
                    Some(shutdown) => {
                        let _ = shutdown.changed().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => break,
            _ = &mut writer_done_rx => break,
            incoming = ws_rx.next() => match incoming {
                Some(Ok(axum::extract::ws::Message::Text(text))) => {
                    let Ok(message) = serde_json::from_str::<WsClientMsg>(&text) else {
                        continue;
                    };
                    if matches!(message, WsClientMsg::Sync { chat_id: Some(_) })
                        && tx.start_sync().await.is_err()
                    {
                        break;
                    }
                    if client_tx.send(message).await.is_err() {
                        break;
                    }
                }
                Some(Ok(axum::extract::ws::Message::Ping(payload))) => {
                    if tx.pong(payload).await.is_err() {
                        break;
                    }
                }
                Some(Ok(axum::extract::ws::Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }

    client_task.abort();
    feed_forwarder.abort();
    writer.abort();
    match machine_id.as_deref() {
        Some(machine_id) => state.hub.unregister_machine(machine_id, conn_id),
        None => state.hub.unregister_member(user.0.id, member.conn_id),
    }
}

async fn handle_client_msg(
    state: &AppState,
    user: &AuthUser,
    member: &Member,
    message: WsClientMsg,
) {
    match message {
        WsClientMsg::Sync {
            chat_id: Some(chat_id),
        } => feed::run_sync_started(state, user, chat_id, &member.sink).await,
        WsClientMsg::Sync { chat_id: None } => {}
        WsClientMsg::ToolResult {
            chat_id,
            call_id,
            content,
            is_error,
            meta,
        } => {
            let result = async {
                let store = state.store().await?;
                store
                    .chats()
                    .get_chat(user.0.org_id, chat_id, &user.0)
                    .await?;
                crate::http::internal::restate_send_one_way(
                    state,
                    "ChatRunner",
                    &format!("{chat_id}/complete_tool"),
                    json!({
                        "call_id": call_id,
                        "content": content,
                        "is_error": is_error,
                        "meta": meta,
                    }),
                )
                .await?;
                Ok::<(), crate::http::error::ApiError>(())
            }
            .await;
            if let Err(error) = result {
                let _ = member
                    .sink
                    .send(WsServerMsg::Error {
                        message: error.message,
                    })
                    .await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> AuthUser {
        AuthUser(crate::store::identity::UserRow {
            id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            email: "test@example.com".into(),
            role: "member".into(),
            identity_type: "managed".into(),
            display_name: None,
            avatar_url: None,
        })
    }

    #[tokio::test]
    async fn unknown_client_messages_are_ignored_without_closing() {
        let state = AppState::from_config(crate::config::Config::test_config());
        let (sink, _rx) = socket_channel(1);
        let member = crate::http::hub::Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink,
            label: None,
        };
        // Unknown envelopes are discarded by the socket reader before this handler.
        handle_client_msg(
            &state,
            &user(),
            &member,
            WsClientMsg::Sync { chat_id: None },
        )
        .await;
    }

    #[tokio::test]
    async fn sync_marker_is_enqueued_before_later_live_output() {
        let (sink, mut receiver) = socket_channel(4);
        sink.start_sync().await.unwrap();
        sink.send(WsServerMsg::LiveFrame {
            chat_id: Uuid::now_v7(),
            machine_id: None,
            event: protocol::api::StreamEvent::Delta {
                content: "live".into(),
            },
        })
        .await
        .unwrap();
        assert!(matches!(
            receiver.recv().await,
            Some(SocketOutput::SyncStart)
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(SocketOutput::Message(WsServerMsg::LiveFrame { .. }))
        ));
    }

    #[test]
    fn ticket_is_single_use_and_short_lived() {
        let store = TicketStore::default();
        let u = user();
        let t = store.mint(u);
        assert!(store.consume(&t).is_some());
        assert!(store.consume(&t).is_none(), "second consume must fail");
        let t2 = store.mint(user());
        store.tickets.lock().unwrap().get_mut(&t2).unwrap().1 =
            std::time::Instant::now() - std::time::Duration::from_secs(60);
        assert!(store.consume(&t2).is_none(), "expired ticket must fail");
    }
}
