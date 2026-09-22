//! Per-client WebSocket endpoint (spec §1): single-use ticket auth, one
//! upgrade route, per-user socket caps live in the Hub (Task 3). Browsers
//! cannot send headers on upgrade, and long-lived tokens in a query string
//! leak into access logs — hence the ticket hop over the normal
//! authenticated HTTP session.

use crate::http::auth::AuthUser;
use crate::http::feed;
use crate::http::hub::Member;
use crate::state::AppState;
use axum::extract::ConnectInfo;
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use protocol::ws::{WsClientMsg, WsServerMsg};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

/// Single-use, short-TTL connect tickets. They are in-memory because tickets
/// are worthless after a restart; clients mint a fresh one on every connect.
#[derive(Clone, Default)]
pub struct TicketStore {
    tickets: Arc<Mutex<HashMap<String, (TicketIdentity, std::time::Instant)>>>,
}

pub struct TicketIdentity {
    user: AuthUser,
    session_hash: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}

impl TicketStore {
    const TTL: std::time::Duration = std::time::Duration::from_secs(30);

    pub fn mint(&self, user: TicketIdentity) -> String {
        let mut tickets = self.tickets.lock().unwrap();
        tickets.retain(|_, (_, at)| at.elapsed() < Self::TTL);
        let ticket = format!("gst_{}", Uuid::now_v7().simple());
        tickets.insert(ticket.clone(), (user, std::time::Instant::now()));
        ticket
    }

    pub fn consume(&self, ticket: &str) -> Option<TicketIdentity> {
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
    headers: axum::http::HeaderMap,
) -> Result<Json<Value>, crate::http::error::ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| crate::http::error::ApiError::unauthorized("missing bearer"))?;
    let (session_hash, expires_at) = state.store().await?.identity().session_grant(token).await?;
    let ticket = state.ws_tickets.mint(TicketIdentity {
        user,
        session_hash,
        expires_at,
    });
    Ok(Json(json!({ "ticket": ticket })))
}

/// Upgrade query: `?ticket=<single-use>&client_id=<stable browser id>&machine_id=<opt>&machine_name=<opt>`.
/// `client_id` identifies the browser across tabs (member identity);
/// `machine_id` (desktop only) claims the machine's singleton slot. The
/// `machine_*` params carry registry metadata (desktop 0.4.0 omits them;
/// empty values are stored as NULL).
#[derive(serde::Deserialize)]
pub struct UpgradeQuery {
    ticket: String,
    client_id: Option<String>,
    machine_id: Option<String>,
    machine_name: Option<String>,
    machine_fingerprint: Option<String>,
    machine_os: Option<String>,
    machine_os_version: Option<String>,
    machine_app_version: Option<String>,
    instance_id: Option<Uuid>,
    #[serde(default)]
    resume: bool,
}

/// Desktop-supplied registry metadata from the upgrade query.
#[derive(Default, Clone)]
struct MachineConnectMeta {
    label: Option<String>,
    fingerprint: Option<String>,
    os: Option<String>,
    os_version: Option<String>,
    app_version: Option<String>,
}

impl MachineConnectMeta {
    fn from_query(q: &UpgradeQuery) -> Self {
        Self {
            label: q.machine_name.clone(),
            fingerprint: q.machine_fingerprint.clone(),
            os: q.machine_os.clone(),
            os_version: q.machine_os_version.clone(),
            app_version: q.machine_app_version.clone(),
        }
    }
}

async fn upgrade(
    State(state): State<AppState>,
    Query(q): Query<UpgradeQuery>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    ws: WebSocketUpgrade,
) -> Result<axum::response::Response, crate::http::error::ApiError> {
    let user = state
        .ws_tickets
        .consume(&q.ticket)
        .ok_or_else(|| crate::http::error::ApiError::unauthorized("invalid or expired ticket"))?;
    if !session_valid(&state, &user.session_hash).await {
        return Err(crate::http::error::ApiError::unauthorized(
            "session expired or revoked",
        ));
    }
    let (tx, rx) = socket_channel();
    let machine_meta = MachineConnectMeta::from_query(&q);
    let machine_id = q.machine_id.filter(|s| !s.is_empty());
    if machine_id.is_some() && q.instance_id.is_none() {
        return Err(crate::http::error::ApiError::bad_request(
            "machine connections require instance_id",
        ));
    }
    let instance_id = q.instance_id.unwrap_or_else(Uuid::now_v7);
    let resume = q.resume;
    let client_id = q.client_id.unwrap_or_else(|| Uuid::now_v7().to_string());
    Ok(ws.on_upgrade(move |socket| async move {
        drive_socket(
            state,
            user,
            client_id,
            machine_id,
            machine_meta,
            Some(peer.ip()),
            instance_id,
            resume,
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
    Pong(axum::body::Bytes),
    Ping(axum::body::Bytes),
}

// Slow sockets disconnect and resync on reconnect. Count queued, in-flight,
// and sync-deferred output, so neither a stalled write nor an open sync
// bracket can hide an overflowing backlog from the writer's watchdog.
const SOCKET_HIGH_WATER: usize = 4096;
// A socket that cannot flush its terminal notice within this deadline is
// treated as dead. No socket write may delay eviction beyond this bound.
const TERMINAL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
// Registry last_seen refreshes at most this often per machine socket; the
// ping heartbeat itself runs faster.
const LAST_SEEN_REFRESH: Duration = Duration::from_secs(30);

struct SocketBacklog {
    pending: AtomicUsize,
    overloaded: watch::Sender<bool>,
    pong: watch::Sender<Vec<u8>>,
    auth_required: watch::Sender<bool>,
}

/// The one outbound queue consumed by a socket's writer task.
#[derive(Clone)]
pub struct SocketSink {
    tx: mpsc::UnboundedSender<SocketOutput>,
    /// All clones share one short enqueue critical section; no await or
    /// capacity reservation occurs while this mutex is held.
    ordering: Arc<Mutex<()>>,
    backlog: Arc<SocketBacklog>,
}

impl SocketSink {
    fn enqueue(&self, output: SocketOutput) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        let _ordering = self.ordering.lock().unwrap();
        let pending = self.backlog.pending.fetch_add(1, Ordering::Relaxed) + 1;
        if let Err(error) = self.tx.send(output) {
            self.backlog.pending.fetch_sub(1, Ordering::Relaxed);
            return Err(error);
        }
        if pending > SOCKET_HIGH_WATER {
            // Latched until disconnect; the writer observes this even while
            // awaiting a permanently stalled network write.
            self.backlog.overloaded.send_replace(true);
        }
        Ok(())
    }

    pub(crate) fn try_send(
        &self,
        message: WsServerMsg,
    ) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        self.enqueue(SocketOutput::Message(message))
    }

    pub(crate) async fn send(
        &self,
        message: WsServerMsg,
    ) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        if matches!(message, WsServerMsg::AuthRequired) {
            self.backlog.auth_required.send_replace(true);
            return Ok(());
        }
        self.enqueue(SocketOutput::Message(message))
    }

    /// A live queue always receives its ordered terminal notice. The watch
    /// signal also lets the writer bypass stale output to flush this notice.
    pub(crate) fn displace(&self) {
        let _ = self.enqueue(SocketOutput::Message(WsServerMsg::Displaced));
    }

    pub(crate) async fn start_sync(&self) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        self.enqueue(SocketOutput::SyncStart)
    }

    async fn pong(
        &self,
        payload: axum::body::Bytes,
    ) -> Result<(), mpsc::error::SendError<SocketOutput>> {
        self.enqueue(SocketOutput::Pong(payload))
    }
}

pub(crate) fn socket_channel() -> (SocketSink, mpsc::UnboundedReceiver<SocketOutput>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        SocketSink {
            tx,
            ordering: Arc::new(Mutex::new(())),
            backlog: Arc::new(SocketBacklog {
                pending: AtomicUsize::new(0),
                overloaded: watch::channel(false).0,
                pong: watch::channel(Vec::new()).0,
                auth_required: watch::channel(false).0,
            }),
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
            SocketOutput::Pong(_) | SocketOutput::Ping(_) => Vec::new(),
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

/// Each challenge has a unique payload. Unrelated traffic cannot renew liveness.
async fn session_valid(state: &AppState, hash: &str) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(2), async {
            state.store().await?.identity().session_expiry(hash).await
        })
        .await,
        Ok(Ok(_))
    )
}

async fn watch_session(
    state: &AppState,
    hash: &str,
    expires: chrono::DateTime<chrono::Utc>,
    sink: &SocketSink,
) {
    loop {
        if chrono::Utc::now() >= expires - chrono::Duration::seconds(60)
            || !session_valid(state, hash).await
        {
            let _ = sink.send(WsServerMsg::AuthRequired).await;
            tokio::time::sleep(TERMINAL_WRITE_TIMEOUT * 2).await;
            return;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn heartbeat(state: AppState, sink: SocketSink, machine_id: Option<String>) {
    let mut pong = sink.backlog.pong.subscribe();
    let mut last_refresh: Option<std::time::Instant> = None;
    loop {
        let challenge = Uuid::now_v7().as_bytes().to_vec();
        if sink
            .enqueue(SocketOutput::Ping(challenge.clone().into()))
            .is_err()
        {
            return;
        }
        let matched = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if *pong.borrow_and_update() == challenge {
                    return;
                }
                if pong.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
        if matched.is_err() {
            return;
        }
        // The registry row's liveness timestamp follows the ping heartbeat
        // on a 30 s throttle; the task only lives while the socket lives.
        if let Some(machine_id) = machine_id.as_deref() {
            let due = last_refresh.is_none_or(|at| at.elapsed() >= LAST_SEEN_REFRESH);
            if due {
                if let Ok(store) = state.store().await {
                    if let Err(error) = store.machines().last_seen(machine_id).await {
                        tracing::warn!(%machine_id, ?error, "last_seen refresh failed");
                    }
                }
                last_refresh = Some(std::time::Instant::now());
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn wait_for_flag(signal: &mut watch::Receiver<bool>) {
    while !*signal.borrow_and_update() {
        if signal.changed().await.is_err() {
            break;
        }
    }
}

async fn wait_for_shutdown(signal: &mut Option<watch::Receiver<bool>>) {
    match signal {
        Some(signal) => wait_for_flag(signal).await,
        None => std::future::pending().await,
    }
}

async fn write_socket<W>(
    mut wire: W,
    mut rx: mpsc::UnboundedReceiver<SocketOutput>,
    backlog: Arc<SocketBacklog>,
    mut shutdown: Option<watch::Receiver<bool>>,
) where
    W: futures::Sink<axum::extract::ws::Message> + Unpin,
{
    let mut overloaded = backlog.overloaded.subscribe();
    let mut auth_required = backlog.auth_required.subscribe();
    let terminal = tokio::select! {
        biased;
        _ = wait_for_shutdown(&mut shutdown) => Some(WsServerMsg::Displaced),
        _ = wait_for_flag(&mut auth_required) => Some(WsServerMsg::AuthRequired),
        _ = wait_for_flag(&mut overloaded) => None,
        displaced = async {
            let mut gate = SocketGate::default();
            while let Some(output) = rx.recv().await {
                if matches!(output, SocketOutput::Message(WsServerMsg::Displaced)) {
                    return true;
                }
                if matches!(output, SocketOutput::Pong(_) | SocketOutput::Ping(_)) {
                    let control = match output {
                        SocketOutput::Pong(payload) => axum::extract::ws::Message::Pong(payload),
                        SocketOutput::Ping(payload) => axum::extract::ws::Message::Ping(payload),
                        _ => unreachable!(),
                    };
                    if !matches!(tokio::time::timeout(TERMINAL_WRITE_TIMEOUT, wire.send(control)).await, Ok(Ok(()))) {
                        return false;
                    }
                    backlog.pending.fetch_sub(1, Ordering::Relaxed);
                    continue;
                }
                if matches!(output, SocketOutput::SyncStart) {
                    backlog.pending.fetch_sub(1, Ordering::Relaxed);
                }
                for message in gate.push(output) {
                    let terminal = matches!(message, WsServerMsg::AuthRequired);
                    let text = serde_json::to_string(&message).expect("server message serializes");
                    if !matches!(tokio::time::timeout(TERMINAL_WRITE_TIMEOUT, wire.send(axum::extract::ws::Message::text(text))).await, Ok(Ok(()))) {
                        return false;
                    }
                    backlog.pending.fetch_sub(1, Ordering::Relaxed);
                    if terminal {
                        let _ = tokio::time::timeout(TERMINAL_WRITE_TIMEOUT, wire.close()).await;
                        return false;
                    }
                }
            }
            false
        } => displaced.then_some(WsServerMsg::Displaced),
    };
    if let Some(terminal) = terminal {
        // Displacement bypasses stale queued/sync-deferred frames. Keep the
        // receiver open through the terminal flush: closing it early can
        // make the reader exit on an enqueue error and abort this notice
        // before the hub publishes shutdown. The flush has a hard deadline.
        let _ = tokio::time::timeout(TERMINAL_WRITE_TIMEOUT, async {
            wire.send(axum::extract::ws::Message::text(
                serde_json::to_string(&terminal).unwrap(),
            ))
            .await?;
            wire.close().await
        })
        .await;
    }
}

async fn supervise_socket(
    reader: impl std::future::Future<Output = ()>,
    mut writer: tokio::task::JoinHandle<()>,
    mut shutdown: Option<watch::Receiver<bool>>,
) {
    enum Exit {
        Displaced,
        Reader,
        Writer,
    }
    // Cancellation covers bootstrap, client-queue sends, and reader control
    // ops, not just the wait for the next incoming WebSocket frame.
    let exit = tokio::select! {
        biased;
        _ = wait_for_shutdown(&mut shutdown) => Exit::Displaced,
        _ = &mut writer => Exit::Writer,
        _ = reader => Exit::Reader,
    };
    match exit {
        Exit::Displaced => {
            let _ = writer.await;
        }
        Exit::Reader => {
            writer.abort();
            let _ = writer.await;
        }
        Exit::Writer => {}
    }
}

pub(crate) async fn drive_socket(
    state: AppState,
    identity: TicketIdentity,
    _client_id: String,
    machine_id: Option<String>,
    machine_meta: MachineConnectMeta,
    peer_ip: Option<std::net::IpAddr>,
    instance_id: Uuid,
    resume: bool,
    socket: axum::extract::ws::WebSocket,
    tx: SocketSink,
    rx: mpsc::UnboundedReceiver<SocketOutput>,
) {
    let TicketIdentity {
        user,
        session_hash,
        expires_at,
    } = identity;
    let (mut ws_tx, mut ws_rx) = socket.split();
    let conn_id = Uuid::now_v7();
    let member = Member {
        conn_id,
        user_id: user.0.id,
        org_id: user.0.org_id,
        sink: tx.clone(),
        label: machine_meta.label.clone(),
    };

    let machine_shutdown = match machine_id.as_deref() {
        Some(machine_id) => {
            // Ownership gate before any hub slot is claimed: a registered
            // machine connects only as its owning user (the registry row is
            // the durable identity; the hub enforces the same rule for a
            // live slot). No row yet = a new pairing, allowed.
            if !machine_slot_owned(&state, &user.0, machine_id).await {
                let _ = tokio::time::timeout(
                    TERMINAL_WRITE_TIMEOUT,
                    ws_tx.send(axum::extract::ws::Message::text(
                        serde_json::to_string(&WsServerMsg::Error {
                            message: "machine belongs to another user".into(),
                        })
                        .unwrap(),
                    )),
                )
                .await;
                return;
            }
            match state
                .hub
                .register_machine_instance(member.clone(), machine_id, instance_id, resume)
                .await
            {
                Ok(registration) => {
                    register_machine_record(
                        &state,
                        &user.0,
                        machine_id,
                        &machine_meta,
                        peer_ip,
                    )
                    .await;
                    Some(registration.shutdown)
                }
                Err(crate::http::hub::MachineRejected::ForeignOwner) => {
                    let _ = tokio::time::timeout(
                        TERMINAL_WRITE_TIMEOUT,
                        ws_tx.send(axum::extract::ws::Message::text(
                            serde_json::to_string(&WsServerMsg::Error {
                                message: "machine belongs to another user".into(),
                            })
                            .unwrap(),
                        )),
                    )
                    .await;
                    return;
                }
                Err(crate::http::hub::MachineRejected::Displaced) => {
                let _ = tokio::time::timeout(
                    TERMINAL_WRITE_TIMEOUT,
                    ws_tx.send(axum::extract::ws::Message::text(
                        serde_json::to_string(&WsServerMsg::Displaced).unwrap(),
                    )),
                )
                .await;
                return;
            }
                Err(crate::http::hub::MachineRejected::Cap) => {
                    let _ = tokio::time::timeout(
                        TERMINAL_WRITE_TIMEOUT,
                        ws_tx.send(axum::extract::ws::Message::text(
                            serde_json::to_string(&WsServerMsg::Error {
                                message: "too many connections".into(),
                            })
                            .unwrap(),
                        )),
                    )
                    .await;
                    return;
                }
            }
        }
        None => {
            if state.hub.register_member(member.clone()).is_err() {
                let _ = tokio::time::timeout(
                    TERMINAL_WRITE_TIMEOUT,
                    ws_tx.send(axum::extract::ws::Message::text(
                        serde_json::to_string(&WsServerMsg::Error {
                            message: "too many connections".into(),
                        })
                        .unwrap(),
                    )),
                )
                .await;
                return;
            }
            None
        }
    };

    let writer = tokio::spawn(write_socket(
        ws_tx,
        rx,
        tx.backlog.clone(),
        machine_shutdown.clone(),
    ));
    let mut feed_forwarder = None;
    let (client_tx, mut client_rx) = mpsc::channel(32);
    let client_state = state.clone();
    let client_user = AuthUser(user.0.clone());
    let client_member = member.clone();
    let client_session = session_hash.clone();
    let client_task = tokio::spawn(async move {
        while let Some(message) = client_rx.recv().await {
            if !session_valid(&client_state, &client_session).await {
                break;
            }
            handle_client_msg(&client_state, &client_user, &client_member, message).await;
        }
    });

    let reader = async {
        let feed_receiver = feed::feed_of(&state, &user);
        let _ = member.sink.send(WsServerMsg::Hello).await;
        if let Some(machine) = machine_id.as_deref() {
            crate::worker::funnel::reconcile_machine_tools(&state, machine, conn_id).await;
        }
        match feed::thread_list(&state, user.0.org_id, user.0.id).await {
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
        feed_forwarder = Some(feed::forward_to_socket(feed_receiver, member.sink.clone()));
        loop {
            match ws_rx.next().await {
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
                Some(Ok(axum::extract::ws::Message::Pong(payload))) => {
                    tx.backlog.pong.send_replace(payload.to_vec());
                }
                Some(Ok(axum::extract::ws::Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
    };
    let bounded_reader = async {
        tokio::select! {
            _ = reader => {},
            _ = heartbeat(state.clone(), tx.clone(), machine_id.clone()) => {},
            _ = watch_session(&state, &session_hash, expires_at, &tx) => {},
        }
    };
    supervise_socket(bounded_reader, writer, machine_shutdown).await;

    client_task.abort();
    if let Some(feed_forwarder) = feed_forwarder {
        feed_forwarder.abort();
    }
    match machine_id.as_deref() {
        Some(machine_id) => state.hub.unregister_machine(machine_id, conn_id),
        None => state.hub.unregister_member(user.0.id, member.conn_id),
    }
}

/// Connect-path ownership gate: a registered machine's hub slot is claimed
/// only by its owning user (the registry row is the durable identity; the
/// hub enforces the same rule against a live slot). An unregistered id is a
/// new pairing and passes. Registry unavailability fails closed.
async fn machine_slot_owned(state: &AppState, user: &crate::store::identity::UserRow, machine_id: &str) -> bool {
    let Ok(store) = state.store().await else {
        // Registry unavailable: fail closed — no slot is claimed without an
        // ownership answer.
        tracing::warn!(%machine_id, "machine ownership gate unavailable: no store");
        return false;
    };
    match store.machines().owner_of(machine_id).await {
        Ok(None) => true, // unregistered id: a new pairing for this user
        Ok(Some((owner_id, _org_id))) => owner_id == user.id,
        Err(error) => {
            tracing::warn!(%machine_id, ?error, "machine ownership gate failed");
            false
        }
    }
}

/// Connect-time registration in the durable machine registry: adopts a
/// fingerprint-matched row (re-pair) or inserts a new one. Registry failure
/// never blocks the socket — the hub slot remains the liveness truth.
async fn register_machine_record(
    state: &AppState,
    user: &crate::store::identity::UserRow,
    machine_id: &str,
    meta: &MachineConnectMeta,
    peer_ip: Option<std::net::IpAddr>,
) {
    let Ok(store) = state.store().await else {
        tracing::warn!(%machine_id, "machine registry unavailable: no store");
        return;
    };
    match store
        .machines()
        .upsert_connected(
            user.org_id,
            user.id,
            machine_id,
            meta.label.as_deref(),
            meta.fingerprint.as_deref(),
            meta.os.as_deref(),
            meta.os_version.as_deref(),
            meta.app_version.as_deref(),
            peer_ip.map(|ip| ip.to_string()).as_deref(),
        )
        .await
    {
        Ok(outcome) => {
            if let Some(old) = outcome.adopted_from {
                // The re-key left any live registration under the old id
                // without a registry identity: displace it per the
                // singleton rule.
                let displaced = state.hub.displace_machine(&old);
                tracing::info!(
                    machine_id,
                    old_machine_id = %old,
                    displaced,
                    "machine re-pair adoption"
                );
            }
        }
        Err(error) => {
            tracing::warn!(%machine_id, ?error, "machine registry upsert failed")
        }
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
        WsClientMsg::MachineResponse {
            request_id,
            ok,
            payload,
            error,
        } => state
            .hub
            .resolve_machine_response(&request_id, ok, payload, error),
        WsClientMsg::ToolResult {
            chat_id,
            call_id,
            content,
            is_error,
            meta,
        } => {
            let owns_call =
                state
                    .generations
                    .owns_pending_tool(chat_id, &call_id, member.conn_id);
            if !owns_call {
                return;
            }
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
        let (sink, _rx) = socket_channel();
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_sync_and_live_enqueue_are_serialized() {
        for _ in 0..128 {
            let (sink, mut receiver) = socket_channel();
            let barrier = Arc::new(tokio::sync::Barrier::new(3));
            let sync_sink = sink.clone();
            let sync_barrier = barrier.clone();
            let sync = tokio::spawn(async move {
                sync_barrier.wait().await;
                sync_sink.start_sync().await.unwrap();
            });
            let live_sink = sink.clone();
            let live_barrier = barrier.clone();
            let chat_id = Uuid::now_v7();
            let live = tokio::spawn(async move {
                live_barrier.wait().await;
                live_sink
                    .send(WsServerMsg::LiveFrame {
                        chat_id,
                        generation_id: Uuid::nil(),
                        seq: 1,
                        machine_id: None,
                        event: protocol::api::StreamEvent::Delta {
                            content: "live".into(),
                        },
                    })
                    .await
                    .unwrap();
            });
            barrier.wait().await;
            sync.await.unwrap();
            live.await.unwrap();

            let first = receiver.recv().await.unwrap();
            let second = receiver.recv().await.unwrap();
            assert!(matches!(
                (&first, &second),
                (
                    SocketOutput::SyncStart,
                    SocketOutput::Message(WsServerMsg::LiveFrame { .. })
                ) | (
                    SocketOutput::Message(WsServerMsg::LiveFrame { .. }),
                    SocketOutput::SyncStart
                )
            ));

            let mut gate = SocketGate::default();
            let first_frames = gate.push(first);
            let second_frames = gate.push(second);
            if first_frames.is_empty() {
                // The marker won the race, so the concurrent live frame is
                // held until the state-sync bracket closes.
                assert!(second_frames.is_empty());
                let chat_id = Uuid::now_v7();
                assert_eq!(
                    gate.push(SocketOutput::Message(WsServerMsg::SyncBegin { chat_id })),
                    vec![WsServerMsg::SyncBegin { chat_id }]
                );
                let done = gate.push(SocketOutput::Message(WsServerMsg::SyncDone { chat_id }));
                assert!(matches!(
                    done.as_slice(),
                    [WsServerMsg::SyncDone { .. }, WsServerMsg::LiveFrame { .. }]
                ));
            } else {
                // The live frame won the ordering mutex and was therefore
                // entirely before the sync transition.
                assert!(matches!(
                    first_frames.as_slice(),
                    [WsServerMsg::LiveFrame { .. }]
                ));
                assert!(second_frames.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn control_enqueue_never_waits_for_writer_capacity() {
        let (sink, mut rx) = socket_channel();
        sink.send(WsServerMsg::Hello).await.unwrap();
        assert!(futures::poll!(Box::pin(sink.start_sync())).is_ready());
        assert!(futures::poll!(Box::pin(sink.pong(axum::body::Bytes::new()))).is_ready());
        sink.displace();
        assert!(matches!(
            rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Hello)
        ));
        assert!(matches!(rx.try_recv().unwrap(), SocketOutput::SyncStart));
        assert!(matches!(rx.try_recv().unwrap(), SocketOutput::Pong(_)));
        assert!(matches!(
            rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Displaced)
        ));
    }

    #[test]
    fn displacement_waits_for_short_enqueue_lock_instead_of_dropping_notice() {
        let (sink, mut rx) = socket_channel();
        let guard = sink.ordering.try_lock().unwrap();
        let displaced_sink = sink.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            displaced_sink.displace();
            done_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        let result = done_rx.recv_timeout(std::time::Duration::from_millis(50));
        drop(guard);
        worker.join().unwrap();
        assert!(matches!(
            result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(matches!(
            rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Displaced)
        ));
    }

    #[test]
    fn replacement_completes_with_queued_output_and_concurrent_control_enqueue() {
        let hub = Arc::new(crate::http::hub::Hub::default());
        let (sink, mut rx) = socket_channel();
        let u = user();
        let old = Member {
            conn_id: Uuid::now_v7(),
            user_id: u.0.id,
            org_id: u.0.org_id,
            sink: sink.clone(),
            label: None,
        };
        let registration = futures::executor::block_on(hub.register_machine(old, "busy")).unwrap();
        for _ in 0..257 {
            futures::executor::block_on(sink.send(WsServerMsg::Hello)).unwrap();
        }
        // Hold the short critical section so both operations contend. Queue
        // draining remains impossible throughout: this test has no writer.
        let guard = sink.ordering.lock().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let control_sink = sink.clone();
        let control_barrier = barrier.clone();
        let (control_tx, control_rx) = std::sync::mpsc::channel();
        let control = std::thread::spawn(move || {
            control_barrier.wait();
            control_tx
                .send(futures::executor::block_on(control_sink.start_sync()))
                .unwrap();
        });
        let register_barrier = barrier.clone();
        let (registered_tx, registered_rx) = std::sync::mpsc::channel();
        let replacement = Member {
            conn_id: Uuid::now_v7(),
            user_id: u.0.id,
            org_id: u.0.org_id,
            sink: socket_channel().0,
            label: None,
        };
        let register = std::thread::spawn(move || {
            register_barrier.wait();
            registered_tx
                .send(futures::executor::block_on(
                    hub.register_machine(replacement, "busy"),
                ))
                .unwrap();
        });
        barrier.wait();
        let while_locked = registered_rx.recv_timeout(Duration::from_millis(50));
        drop(guard);
        assert!(matches!(
            while_locked,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(
            registered_rx
                .recv_timeout(Duration::from_millis(100))
                .unwrap()
                .unwrap()
                .displaced
        );
        control_rx
            .recv_timeout(Duration::from_millis(100))
            .unwrap()
            .unwrap();
        register.join().unwrap();
        control.join().unwrap();
        assert!(*registration.shutdown.borrow());
        for _ in 0..257 {
            assert!(matches!(
                rx.try_recv().unwrap(),
                SocketOutput::Message(WsServerMsg::Hello)
            ));
        }
        let first = rx.try_recv().unwrap();
        let second = rx.try_recv().unwrap();
        assert!(matches!(
            (first, second),
            (
                SocketOutput::SyncStart,
                SocketOutput::Message(WsServerMsg::Displaced)
            ) | (
                SocketOutput::Message(WsServerMsg::Displaced),
                SocketOutput::SyncStart
            )
        ));
    }

    #[derive(Default)]
    struct WireState {
        stalled: std::sync::atomic::AtomicBool,
        dropped: std::sync::atomic::AtomicBool,
        polled: tokio::sync::Notify,
        waker: futures::task::AtomicWaker,
        messages: Mutex<Vec<axum::extract::ws::Message>>,
    }

    struct TestWire(Arc<WireState>);

    impl futures::Sink<axum::extract::ws::Message> for TestWire {
        type Error = ();
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            self.0.waker.register(cx.waker());
            self.0.polled.notify_one();
            if self.0.stalled.load(Ordering::SeqCst) {
                std::task::Poll::Pending
            } else {
                std::task::Poll::Ready(Ok(()))
            }
        }
        fn start_send(
            self: std::pin::Pin<&mut Self>,
            message: axum::extract::ws::Message,
        ) -> Result<(), ()> {
            self.0.messages.lock().unwrap().push(message);
            Ok(())
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    impl Drop for TestWire {
        fn drop(&mut self) {
            self.0.dropped.store(true, Ordering::SeqCst);
        }
    }

    struct ReaderDropped(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for ReaderDropped {
        fn drop(&mut self) {
            let _ = self.0.take().unwrap().send(());
        }
    }

    #[tokio::test]
    async fn displacement_cancels_reader_and_stalled_writer_within_deadline() {
        let hub = crate::http::hub::Hub::default();
        let (sink, rx) = socket_channel();
        let u = user();
        let old = Member {
            conn_id: Uuid::now_v7(),
            user_id: u.0.id,
            org_id: u.0.org_id,
            sink: sink.clone(),
            label: None,
        };
        let registration = hub.register_machine(old, "stalled").await.unwrap();
        let wire = Arc::new(WireState::default());
        wire.stalled.store(true, Ordering::SeqCst);
        sink.send(WsServerMsg::Hello).await.unwrap();
        let writer = tokio::spawn(write_socket(
            TestWire(wire.clone()),
            rx,
            sink.backlog.clone(),
            Some(registration.shutdown.clone()),
        ));
        tokio::time::timeout(Duration::from_millis(100), wire.polled.notified())
            .await
            .unwrap();
        // A backlog remains queued while the writer is permanently stalled.
        for _ in 0..256 {
            sink.send(WsServerMsg::Hello).await.unwrap();
        }
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel::<()>();
        let reader = async move {
            let _guard = ReaderDropped(Some(dropped_tx));
            sink.start_sync().await.unwrap();
            sink.pong(axum::body::Bytes::new()).await.unwrap();
            entered_tx.send(()).unwrap();
            // A full client-work queue or slow bootstrap is also cancellable.
            std::future::pending::<()>().await;
        };
        let supervisor = tokio::spawn(supervise_socket(
            reader,
            writer,
            Some(registration.shutdown),
        ));
        tokio::time::timeout(Duration::from_millis(100), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let replacement = Member {
            conn_id: Uuid::now_v7(),
            user_id: u.0.id,
            org_id: u.0.org_id,
            sink: socket_channel().0,
            label: None,
        };
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                hub.register_machine(replacement, "stalled")
            )
            .await
            .unwrap()
            .unwrap()
            .displaced
        );
        tokio::time::timeout(Duration::from_millis(100), dropped_rx)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(
            TERMINAL_WRITE_TIMEOUT + Duration::from_millis(300),
            supervisor,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(wire.dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn displaced_notice_flushes_when_temporary_wire_stall_clears() {
        let (sink, rx) = socket_channel();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let wire = Arc::new(WireState::default());
        wire.stalled.store(true, Ordering::SeqCst);
        sink.send(WsServerMsg::Hello).await.unwrap();
        let writer = tokio::spawn(write_socket(
            TestWire(wire.clone()),
            rx,
            sink.backlog.clone(),
            Some(shutdown_rx),
        ));
        tokio::time::timeout(Duration::from_millis(100), wire.polled.notified())
            .await
            .unwrap();
        sink.displace();
        shutdown_tx.send(true).unwrap();
        // The shutdown path attempts the terminal write despite the stall.
        tokio::time::timeout(Duration::from_millis(100), wire.polled.notified())
            .await
            .unwrap();
        wire.stalled.store(false, Ordering::SeqCst);
        wire.waker.wake();
        tokio::time::timeout(Duration::from_millis(100), writer)
            .await
            .unwrap()
            .unwrap();
        let messages = wire.messages.lock().unwrap();
        assert_eq!(messages.len(), 1);
        let axum::extract::ws::Message::Text(text) = &messages[0] else {
            panic!("expected terminal text")
        };
        assert_eq!(
            serde_json::from_str::<WsServerMsg>(text).unwrap(),
            WsServerMsg::Displaced
        );
    }

    #[tokio::test]
    async fn high_water_disconnects_even_during_a_stalled_write() {
        let (sink, rx) = socket_channel();
        let wire = Arc::new(WireState::default());
        wire.stalled.store(true, Ordering::SeqCst);
        sink.send(WsServerMsg::Hello).await.unwrap();
        let writer = tokio::spawn(write_socket(
            TestWire(wire.clone()),
            rx,
            sink.backlog.clone(),
            None,
        ));
        tokio::time::timeout(Duration::from_millis(100), wire.polled.notified())
            .await
            .unwrap();
        for _ in 0..SOCKET_HIGH_WATER {
            sink.send(WsServerMsg::Hello).await.unwrap();
        }
        tokio::time::timeout(Duration::from_millis(100), writer)
            .await
            .unwrap()
            .unwrap();
        assert!(wire.dropped.load(Ordering::SeqCst));
        assert!(sink.send(WsServerMsg::Hello).await.is_err());
    }

    #[tokio::test]
    async fn high_water_counts_sync_deferred_frames() {
        let (sink, rx) = socket_channel();
        let wire = Arc::new(WireState::default());
        sink.start_sync().await.unwrap();
        let writer = tokio::spawn(write_socket(
            TestWire(wire.clone()),
            rx,
            sink.backlog.clone(),
            None,
        ));
        let chat_id = Uuid::now_v7();
        for _ in 0..=SOCKET_HIGH_WATER {
            sink.send(WsServerMsg::ChatStatus {
                chat_id,
                generating: true,
            })
            .await
            .unwrap();
            tokio::task::yield_now().await;
        }
        tokio::time::timeout(Duration::from_millis(100), writer)
            .await
            .unwrap()
            .unwrap();
        assert!(wire.messages.lock().unwrap().is_empty());
        assert!(wire.dropped.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn open_silent_peer_expires_without_tcp_close() {
        let (sink, mut rx) = socket_channel();
        let state = AppState::from_config(crate::config::Config::test_config());
        let task = tokio::spawn(heartbeat(state, sink.clone(), None));
        assert!(matches!(rx.recv().await, Some(SocketOutput::Ping(_))));
        tokio::time::advance(Duration::from_secs(11)).await;
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn only_matched_pong_keeps_peer_alive() {
        let (sink, mut rx) = socket_channel();
        let state = AppState::from_config(crate::config::Config::test_config());
        let task = tokio::spawn(heartbeat(state, sink.clone(), None));
        let Some(SocketOutput::Ping(payload)) = rx.recv().await else {
            panic!("ping")
        };
        sink.backlog.pong.send_replace(payload.to_vec());
        tokio::time::advance(Duration::from_secs(5)).await;
        let Some(SocketOutput::Ping(_)) = rx.recv().await else {
            panic!("next ping")
        };
        sink.backlog.pong.send_replace(vec![99]);
        tokio::time::advance(Duration::from_secs(11)).await;
        task.await.unwrap();
    }

    #[test]
    fn ticket_is_single_use_and_short_lived() {
        let store = TicketStore::default();
        let u = user();
        let t = store.mint(TicketIdentity {
            user: u,
            session_hash: "test".into(),
            expires_at: chrono::Utc::now(),
        });
        assert!(store.consume(&t).is_some());
        assert!(store.consume(&t).is_none(), "second consume must fail");
        let t2 = store.mint(TicketIdentity {
            user: user(),
            session_hash: "test".into(),
            expires_at: chrono::Utc::now(),
        });
        store.tickets.lock().unwrap().get_mut(&t2).unwrap().1 =
            std::time::Instant::now() - std::time::Duration::from_secs(60);
        assert!(store.consume(&t2).is_none(), "expired ticket must fail");
    }
}
