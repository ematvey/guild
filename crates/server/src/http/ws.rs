//! Per-client WebSocket endpoint (spec §1): single-use ticket auth, one
//! upgrade route, per-user socket caps live in the Hub (Task 3). Browsers
//! cannot send headers on upgrade, and long-lived tokens in a query string
//! leak into access logs — hence the ticket hop over the normal
//! authenticated HTTP session.

use crate::http::auth::AuthUser;
use crate::state::AppState;
use axum::{
    extract::{Query, State, WebSocketUpgrade},
    Json, Router,
};
use protocol::ws::WsServerMsg;
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
    let _user = state
        .ws_tickets
        .consume(&q.ticket)
        .ok_or_else(|| crate::http::error::ApiError::unauthorized("invalid or expired ticket"))?;
    let (_tx, rx) = mpsc::channel::<WsServerMsg>(256);
    let machine_id = q.machine_id.filter(|s| !s.is_empty());
    let client_id = q.client_id.unwrap_or_else(|| Uuid::now_v7().to_string());
    let _machine_name = q.machine_name;
    Ok(ws.on_upgrade(move |socket| async move {
        drive_socket(state, client_id, machine_id, socket, rx).await;
    }))
}

#[allow(dead_code)]
pub(crate) type SocketSink = mpsc::Sender<WsServerMsg>;

/// Stub: Task 3 replaces this with real hub registration + read/write pump.
#[allow(dead_code)]
pub(crate) async fn socket_loop(
    _state: AppState,
    _user: AuthUser,
    _client_id: String,
    _machine_id: Option<String>,
    _ws: WebSocketUpgrade,
    _rx: mpsc::Receiver<WsServerMsg>,
) {
}

/// Stub: Task 3 replaces this with real hub registration + read/write pump.
pub(crate) async fn drive_socket(
    _state: AppState,
    _client_id: String,
    _machine_id: Option<String>,
    _socket: axum::extract::ws::WebSocket,
    mut rx: mpsc::Receiver<WsServerMsg>,
) {
    while rx.recv().await.is_some() {}
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
