//! Per-client WebSocket endpoint (spec §1): single-use ticket auth, one
//! upgrade route, per-user socket caps live in the Hub (Task 3). Browsers
//! cannot send headers on upgrade, and long-lived tokens in a query string
//! leak into access logs — hence the ticket hop over the normal
//! authenticated HTTP session.

use crate::http::auth::AuthUser;
use crate::http::hub::Member;
use crate::state::AppState;
use axum::{
    extract::{Query, State, WebSocketUpgrade},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use protocol::ws::{WsClientMsg, WsServerMsg};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
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
    let (tx, rx) = mpsc::channel::<WsServerMsg>(256);
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

#[allow(dead_code)]
pub(crate) type SocketSink = mpsc::Sender<WsServerMsg>;

pub(crate) async fn drive_socket(
    state: AppState,
    user: AuthUser,
    _client_id: String,
    machine_id: Option<String>,
    machine_name: Option<String>,
    socket: axum::extract::ws::WebSocket,
    tx: SocketSink,
    mut rx: mpsc::Receiver<WsServerMsg>,
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
        Some(machine_id) => match state
            .hub
            .register_machine_with_shutdown(member.clone(), machine_id)
        {
            Ok((_, shutdown)) => Some(shutdown),
            Err(()) => {
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

    let _ = member.sink.send(WsServerMsg::Hello).await;
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
            outgoing = rx.recv() => match outgoing {
                Some(msg) => {
                    let displaced = matches!(&msg, WsServerMsg::Displaced);
                    let text = serde_json::to_string(&msg).unwrap();
                    if ws_tx.send(axum::extract::ws::Message::text(text)).await.is_err() || displaced {
                        break;
                    }
                }
                None => break,
            },
            incoming = ws_rx.next() => match incoming {
                Some(Ok(axum::extract::ws::Message::Text(text))) => {
                    if handle_client_msg(&state, &member, &machine_id, &text).await {
                        break;
                    }
                }
                Some(Ok(axum::extract::ws::Message::Ping(payload))) => {
                    if ws_tx.send(axum::extract::ws::Message::Pong(payload)).await.is_err() {
                        break;
                    }
                }
                Some(Ok(axum::extract::ws::Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }

    match machine_id.as_deref() {
        Some(machine_id) => state.hub.unregister_machine(machine_id, conn_id),
        None => state.hub.unregister_member(user.0.id, member.conn_id),
    }
}

async fn handle_client_msg(
    _state: &AppState,
    _member: &Member,
    _machine_id: &Option<String>,
    text: &str,
) -> bool {
    let _ = serde_json::from_str::<WsClientMsg>(text);
    false
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
        let member = crate::http::hub::Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink: mpsc::channel(1).0,
            label: None,
        };
        assert!(!handle_client_msg(&state, &member, &None, r#"{"type":"future"}"#).await);
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
