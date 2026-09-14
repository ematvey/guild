//! Org events API (spec §4.6/§4.8): recent list + SSE stream fanned out via
//! Postgres LISTEN/NOTIFY.
//!
//! The stream doubles as the desktop app's single standing connection — the
//! user fan-out bus (docs/specs/2026-09-13-single-process-desktop.md): a
//! connect carrying `machine_id` registers the machine executor AND
//! multiplexes every generation frame of the user's chats to the device
//! (which may be tray-inactive). Web clients (no `machine_id`) get org
//! events only.

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use crate::store::Store;
use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::{Json, Router};
use futures::Stream;
use protocol::api::StreamEvent;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/events", axum::routing::get(list))
        .route("/api/v1/events/stream", axum::routing::get(stream))
}

/// Server-wide cap on concurrent event streams — each pins one dedicated
/// Postgres LISTEN connection for its lifetime, and the host's
/// max_connections also serves every store checkout.
pub const EVENT_STREAM_MAX_GLOBAL: usize = 64;

/// Per-user cap on concurrent event streams (one desktop app + a few web
/// tabs; a scripted client must not pin hundreds of connections).
pub const EVENT_STREAM_MAX_PER_USER: usize = 3;

/// Concurrent event-stream budget: every stream pins one dedicated Postgres
/// LISTEN connection for its whole lifetime, so the total and the per-user
/// count are bounded — a scripted client must not exhaust the server's
/// Postgres connections (every store checkout would then starve).
pub struct StreamGate {
    global: Arc<tokio::sync::Semaphore>,
    per_user: std::sync::Mutex<HashMap<Uuid, usize>>,
    max_per_user: usize,
}

/// Which budget refused the stream: the user's own (429) or the server's
/// (503).
#[derive(Debug)]
pub enum StreamGateError {
    PerUser,
    Global,
}

/// Held for the stream's lifetime; dropping it frees both budgets.
pub struct StreamPermit {
    gate: Arc<StreamGate>,
    user: Uuid,
    _global: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for StreamPermit {
    fn drop(&mut self) {
        let mut per_user = self.gate.per_user.lock().unwrap();
        if let Some(n) = per_user.get_mut(&self.user) {
            *n -= 1;
            if *n == 0 {
                per_user.remove(&self.user);
            }
        }
    }
}

impl StreamGate {
    /// Server-wide cap and per-user cap.
    pub fn with_caps(max_global: usize, max_per_user: usize) -> Self {
        Self {
            global: Arc::new(tokio::sync::Semaphore::new(max_global)),
            per_user: std::sync::Mutex::new(HashMap::new()),
            max_per_user,
        }
    }

    /// Acquires a stream slot: the per-user count first, then the global
    /// semaphore (try — a full gate rejects instead of queueing). The
    /// caller must move the permit into the stream body so it lives as
    /// long as the connection.
    pub fn try_acquire(self: &Arc<Self>, user: Uuid) -> Result<StreamPermit, StreamGateError> {
        {
            let mut per_user = self.per_user.lock().unwrap();
            let count = per_user.entry(user).or_insert(0);
            if *count >= self.max_per_user {
                return Err(StreamGateError::PerUser);
            }
            *count += 1;
        }
        match self.global.clone().try_acquire_owned() {
            Ok(permit) => Ok(StreamPermit {
                gate: self.clone(),
                user,
                _global: permit,
            }),
            Err(_) => {
                let mut per_user = self.per_user.lock().unwrap();
                if let Some(n) = per_user.get_mut(&user) {
                    *n -= 1;
                    if *n == 0 {
                        per_user.remove(&user);
                    }
                }
                Err(StreamGateError::Global)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_user_cap_rejects_the_fourth_stream_and_frees_on_drop() {
        let gate = Arc::new(StreamGate::with_caps(10, 3));
        let u = Uuid::now_v7();
        let p1 = gate.try_acquire(u);
        let p2 = gate.try_acquire(u);
        let p3 = gate.try_acquire(u);
        assert!(p1.is_ok() && p2.is_ok() && p3.is_ok());
        assert!(matches!(gate.try_acquire(u), Err(StreamGateError::PerUser)));
        // Another user is unaffected by the first user's budget.
        assert!(gate.try_acquire(Uuid::now_v7()).is_ok());
        drop(p2);
        assert!(gate.try_acquire(u).is_ok());
    }

    #[test]
    fn global_cap_rejects_across_users_and_frees_on_drop() {
        let gate = Arc::new(StreamGate::with_caps(2, 5));
        let p1 = gate.try_acquire(Uuid::now_v7()).unwrap();
        let p2 = gate.try_acquire(Uuid::now_v7()).unwrap();
        assert!(matches!(gate.try_acquire(Uuid::now_v7()), Err(StreamGateError::Global)));
        drop(p1);
        drop(p2);
        assert!(gate.try_acquire(Uuid::now_v7()).is_ok());
    }

    #[test]
    fn a_refused_global_slot_frees_the_per_user_count() {
        let gate = Arc::new(StreamGate::with_caps(2, 2));
        let h1 = gate.try_acquire(Uuid::now_v7()).unwrap();
        let h2 = gate.try_acquire(Uuid::now_v7()).unwrap();
        let u = Uuid::now_v7();
        assert!(matches!(gate.try_acquire(u), Err(StreamGateError::Global)));
        // The failed acquisition must not consume the user's own budget:
        // once the global budget frees up, the user gets its full share.
        drop(h1);
        drop(h2);
        let p1 = gate.try_acquire(u).unwrap();
        let p2 = gate.try_acquire(u).unwrap();
        drop(p1);
        drop(p2);
    }
}

async fn list(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let events = store.events().list(user.0.org_id, 200).await?;
    Ok(Json(json!({ "events": events })))
}

/// Per-device sync tracker: follows the user's active generations and
/// mirrors their frames onto this connection. Live frames come from each
/// generation's broadcast channel; on first tracking, in-flight state is
/// replayed (accumulated deltas + suspended tools), so a freshly connected
/// or reconnected device is current without a separate attach call. The
/// `pending_tools` registry closes the subscribe race (a tool registered
/// between ticks is still picked up).
struct DeviceSync {
    state: AppState,
    store: Arc<Store>,
    org: Uuid,
    user_id: Uuid,
    /// chat_id → bound machine (None = unbound; client tools never run there)
    chats: HashMap<Uuid, Option<String>>,
    subs: HashMap<Uuid, broadcast::Receiver<StreamEvent>>,
    seen_calls: HashSet<String>,
    slow_tick: u32,
}

impl DeviceSync {
    fn new(state: AppState, store: Arc<Store>, org: Uuid, user_id: Uuid, _machine_id: String) -> Self {
        Self {
            state,
            store,
            org,
            user_id,
            chats: HashMap::new(),
            subs: HashMap::new(),
            seen_calls: HashSet::new(),
            // 3 → the first poll wraps to 0 and refreshes bindings, so a
            // frame dispatched right after connect is not delayed by 2s.
            slow_tick: 3,
        }
    }

    /// Wrap one frame for the wire: the chat it belongs to and the machine
    /// the chat executes on (the matching device runs client tools; the
    /// rest render them).
    fn wrap(chat_id: &Uuid, bound: &Option<String>, ev: StreamEvent) -> Value {
        json!({
            "chat_id": chat_id.to_string(),
            "machine_id": bound,
            "event": ev,
        })
    }

    /// Fragment frames the fan-out skips: tool-argument streaming is a
    /// turn-stream nicety; the completed call arrives as ToolStarted.
    fn forwardable(ev: &StreamEvent) -> bool {
        !matches!(ev, StreamEvent::ToolCallDelta { .. } | StreamEvent::ToolCallDone { .. })
    }

    /// One poll: refresh chat bindings (every 4th tick), subscribe to newly
    /// active generations of this user's chats (with in-flight replay),
    /// drain live frames, replay unseen suspended tools, prune ended
    /// generations. Sync against the generations map (std Mutex — never
    /// held across an await).
    async fn poll(&mut self) -> Vec<Value> {
        self.slow_tick = (self.slow_tick + 1) % 4;
        if self.slow_tick == 0 {
            if let Ok(chats) = self.store.chats().list_chats(self.org, self.user_id).await {
                self.chats = chats.into_iter().map(|c| (c.id, c.machine_id)).collect();
            }
        }
        let mut out = Vec::new();
        let mut live: Vec<Uuid> = Vec::new();
        // Take the subscription map out so the drain loop can touch the
        // seen-set and the wrapper without aliasing `self`.
        let mut subs = std::mem::take(&mut self.subs);
        // Newly tracked generations to replay after the map lock is dropped:
        // (chat_id, bound, text buf, thinking buf, suspended tools).
        let mut replay: Vec<(
            Uuid,
            Option<String>,
            Arc<tokio::sync::RwLock<String>>,
            Arc<tokio::sync::RwLock<String>>,
            Vec<(String, String, String)>,
        )> = Vec::new();
        {
            let gens = self.state.generations.lock().unwrap();
            for (chat_id, g) in gens.iter() {
                if !self.chats.contains_key(chat_id) {
                    continue;
                }
                live.push(*chat_id);
                if subs.contains_key(chat_id) {
                    continue;
                }
                // Newly tracked generation: replay in-flight state so this
                // device is current (text/thinking snapshots + suspended
                // tools), then subscribe for live frames. Reads happen after
                // the lock drops (std Mutex must not span an await).
                let bound = self.chats.get(chat_id).cloned().flatten();
                let mut pending = Vec::new();
                for (call_id, t) in g.pending_tools.lock().unwrap().iter() {
                    if self.seen_calls.insert(call_id.clone()) {
                        pending.push((call_id.clone(), t.name.clone(), t.arguments.clone()));
                    }
                }
                replay.push((*chat_id, bound, g.text.clone(), g.thinking.clone(), pending));
                subs.insert(*chat_id, g.tx.subscribe());
            }
            for (chat_id, rx) in subs.iter_mut() {
                let Some(bound) = self.chats.get(chat_id).cloned() else { continue };
                loop {
                    match rx.try_recv() {
                        Ok(ev) => {
                            if !Self::forwardable(&ev) {
                                continue;
                            }
                            if let StreamEvent::ToolStarted { call_id, .. } = &ev {
                                if !self.seen_calls.insert(call_id.clone()) {
                                    continue;
                                }
                            }
                            out.push(Self::wrap(chat_id, &bound, ev));
                        }
                        Err(broadcast::error::TryRecvError::Empty) => break,
                        Err(broadcast::error::TryRecvError::Closed) => break,
                        Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                    }
                }
            }
        }
        self.subs = subs;
        // Prune subscriptions for generations that have ended.
        self.subs.retain(|id, _| live.contains(id));
        // In-flight replay for newly tracked generations (map lock dropped).
        for (chat_id, bound, text, think, pending) in replay {
            let text_snap = text.read().await.clone();
            if !text_snap.is_empty() {
                out.push(Self::wrap(&chat_id, &bound, StreamEvent::Delta { content: text_snap }));
            }
            let think_snap = think.read().await.clone();
            if !think_snap.is_empty() {
                out.push(Self::wrap(
                    &chat_id,
                    &bound,
                    StreamEvent::ThinkingDelta { content: think_snap },
                ));
            }
            for (call_id, name, args) in pending {
                out.push(json!({
                    "chat_id": chat_id.to_string(),
                    "machine_id": bound,
                    "event": StreamEvent::ToolStarted {
                        call_id,
                        name,
                        arguments: args,
                        executor: protocol::api::ToolExecutor::Client,
                    },
                }));
            }
        }
        out
    }
}

async fn stream(
    State(state): State<AppState>,
    user: AuthUser,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let org = user.0.org_id;
    // App-level presence: this connection is held for the app's lifetime
    // and is the liveness signal for client-tool termination detection.
    // The guard lives inside the body generator, so dropping the response
    // (client disconnect) releases it.
    // (client_id is still sent by clients for tracing; executor liveness is
    // heartbeat-based, see the machine_id params below.)
    // Machine-executor registration: desktop apps identify the machine they
    // run on; machine tools run only on the chat's bound machine.
    let machine_id = q.get("machine_id").cloned();
    let executor = machine_id.clone().map(|mid| {
        let name = q.get("machine_name").cloned().unwrap_or_default();
        state.executor_acquire(&mid, &user.0, &name)
    });
    // Budget check before the dedicated Postgres connection is opened: the
    // user's own streams first (429), then the server-wide cap (503).
    let permit = match state.event_streams.try_acquire(user.0.id) {
        Ok(p) => p,
        Err(e) => {
            return Err(match e {
                StreamGateError::PerUser => ApiError::new(
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    "stream_limit",
                    "too many event streams for this user — close one",
                ),
                StreamGateError::Global => ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "stream_capacity",
                    "the server is at its event-stream capacity — retry later",
                ),
            })
        }
    };
    let store = state.store().await?;
    // Standalone connection, NOT from the request pool: every live stream
    // pins one connection for its whole lifetime, and pool-based listeners
    // exhaust the pool (all authenticated endpoints then hang on pool
    // checkout — see ~/workspace/hanging-commands.md Pattern 6).
    let mut listener = sqlx::postgres::PgListener::connect(&state.config.database_url)
        .await
        .map_err(|e| ApiError::internal(format!("event subscribe failed: {e}")))?;
    listener
        .listen(crate::store::events::NOTIFY_CHANNEL)
        .await
        .map_err(|e| ApiError::internal(format!("event subscribe failed: {e}")))?;
    let mut dispatch = machine_id
        .map(|mid| DeviceSync::new(state.clone(), store.clone(), org, user.0.id, mid));
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let out = async_stream::stream! {
        // Hold the executor guard and the stream budget for as long as this
        // body lives.
        let _executor = executor;
        let _permit = permit;
        loop {
            tokio::select! {
                notification = listener.recv() => {
                    match notification {
                        Ok(notification) => {
                            let payload: Value = match serde_json::from_str(notification.payload()) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            if payload["org_id"].as_str() != Some(&org.to_string()) {
                                continue;
                            }
                            let Some(event_id) = payload["event_id"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                                continue;
                            };
                            let row = store.events().get(org, event_id).await;
                            match row {
                                Ok(Some(event)) => {
                                    let body = serde_json::to_string(&event).unwrap_or_default();
                                    yield Ok(SseEvent::default().event("org_event").data(body));
                                }
                                Ok(None) => continue,
                                Err(e) => {
                                    yield Ok(SseEvent::default().event("error").data(
                                        json!({"message": e.message}).to_string(),
                                    ));
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            yield Ok(SseEvent::default().event("error").data(
                                json!({"message": e.to_string()}).to_string(),
                            ));
                            break;
                        }
                    }
                }
                _ = tick.tick() => {
                    // no dispatch (web mode): the tick is a no-op
                    if let Some(d) = dispatch.as_mut() {
                        for frame in d.poll().await {
                            yield Ok(SseEvent::default().event("app").data(
                                serde_json::to_string(&frame).unwrap_or_default(),
                            ));
                        }
                    }
                }
            }
        }
    };
    Ok(Sse::new(out).keep_alive(KeepAlive::default()))
}
