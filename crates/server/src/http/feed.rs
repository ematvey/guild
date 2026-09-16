use crate::http::auth::AuthUser;
use crate::http::ws::SocketSink;
use crate::state::AppState;
use crate::store::Store;
use protocol::api::StreamEvent;
use protocol::ws::WsServerMsg;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Live frames shared by every connected socket of one user.
#[derive(Clone)]
pub struct FeedHandle {
    pub broadcast: broadcast::Sender<WsServerMsg>,
    prepare: tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Clone)]
struct ChatBinding {
    machine_id: Option<String>,
}

/// One user's generation subscriptions and notification fan-out state.
struct Feed {
    state: AppState,
    store: Arc<Store>,
    org_id: Uuid,
    user_id: Uuid,
    broadcast: broadcast::Sender<WsServerMsg>,
    chats: HashMap<Uuid, ChatBinding>,
    subs: HashMap<Uuid, (Uuid, broadcast::Receiver<StreamEvent>)>,
    slow_tick: u32,
    views: HashMap<Uuid, Value>,
    /// (text.len, thinking.len) of the last published in-flight buffers:
    /// a cheap pre-capture change check so the 100ms tick only captures
    /// chats whose buffers actually moved.
    signatures: HashMap<Uuid, (usize, usize)>,
    /// Last broadcast machine-online state per bound chat: a flip rebroadcasts
    /// the thread list so every device's connection dot updates live.
    presence: HashMap<Uuid, bool>,
}

impl Feed {
    fn new(
        state: AppState,
        store: Arc<Store>,
        org_id: Uuid,
        user_id: Uuid,
        broadcast: broadcast::Sender<WsServerMsg>,
    ) -> Self {
        Self {
            state,
            store,
            org_id,
            user_id,
            broadcast,
            chats: HashMap::new(),
            subs: HashMap::new(),
            // Refresh bindings on the first tick.
            slow_tick: 3,
            views: HashMap::new(),
            signatures: HashMap::new(),
            presence: HashMap::new(),
        }
    }

    async fn refresh_bindings(&mut self) {
        match self
            .store
            .chats()
            .list_chats(self.org_id, self.user_id)
            .await
        {
            Ok(chats) => {
                self.chats = chats
                    .into_iter()
                    .map(|chat| {
                        (
                            chat.id,
                            ChatBinding {
                                machine_id: chat.machine_id,
                            },
                        )
                    })
                    .collect();
            }
            Err(error) => {
                tracing::warn!(error = ?error, user_id = %self.user_id, "feed binding refresh failed")
            }
        }
    }

    /// Command-scoped consumers subscribe before invocation. View consumers
    /// never replay these deltas: they receive the authoritative view below.
    async fn poll(&mut self) {
        self.slow_tick = (self.slow_tick + 1) % 4;
        if self.slow_tick == 0 {
            self.refresh_bindings().await;
        }
        let active = {
            let generations = self.state.generations.lock().unwrap();
            generations
                .iter()
                .filter(|(chat, _)| self.chats.contains_key(chat))
                .map(|(chat, generation)| (*chat, generation.id, generation.tx.clone()))
                .collect::<Vec<_>>()
        };
        // A replaced generation has already emitted its terminal event.
        // Drain that receiver before replacing it with the new generation.
        self.drain_events().await;
        for (chat, id, sender) in &active {
            if self.subs.get(chat).is_none_or(|(old, _)| old != id) {
                self.subs.insert(*chat, (*id, sender.subscribe()));
            }
        }
        self.drain_events().await;
        self.subs.retain(|chat, (id, _)| {
            active
                .iter()
                .any(|(current, generation, _)| current == chat && generation == id)
        });
        self.publish_views().await;
        self.watch_presence().await;
    }

    /// Rebroadcasts the thread list when a bound machine's online state
    /// flips (the connection dot next to the folder chip must move live).
    async fn watch_presence(&mut self) {
        let mut changed = false;
        for (chat_id, binding) in &self.chats {
            let Some(machine_id) = &binding.machine_id else {
                continue;
            };
            let online = self.state.hub.machine_online(machine_id);
            if self.presence.get(chat_id) != Some(&online) {
                self.presence.insert(*chat_id, online);
                changed = true;
            }
        }
        if changed {
            if let Ok(chats) = thread_list(&self.state, self.org_id, self.user_id).await {
                let _ = self.broadcast.send(WsServerMsg::ThreadList { chats });
            }
        }
    }

    async fn drain_events(&mut self) {
        let mut frames = Vec::new();
        for (chat, (generation_id, receiver)) in &mut self.subs {
            loop {
                match receiver.try_recv() {
                    Ok(event) => frames.push((*chat, *generation_id, event)),
                    Err(broadcast::error::TryRecvError::Lagged(_)) => {
                        let _ = self.broadcast.send(WsServerMsg::Error {
                            message: "frames dropped — resync".into(),
                        });
                    }
                    Err(_) => break,
                }
            }
        }
        for (chat_id, generation_id, event) in frames {
            let Some(binding) = self.chats.get(&chat_id) else {
                continue;
            };
            let Ok(seq) = self.store.thread().watermark().await else {
                continue;
            };
            let _ = self.broadcast.send(WsServerMsg::LiveFrame {
                chat_id,
                generation_id,
                seq,
                machine_id: binding.machine_id.clone(),
                event,
            });
        }
    }

    async fn publish_views(&mut self) {
        for chat_id in self.chats.keys().copied().collect::<Vec<_>>() {
            let active = self
                .state
                .generations
                .lock()
                .unwrap()
                .contains_key(&chat_id);
            if !active
                && self
                    .views
                    .get(&chat_id)
                    .is_some_and(|view| view["generating"] == false)
            {
                continue;
            }
            // Cheap pre-capture check: deltas only append, so equal buffer
            // lengths mean the next capture would equal the last view.
            let buffers = self
                .state
                .generations
                .lock()
                .unwrap()
                .get(&chat_id)
                .map(|g| (g.text.clone(), g.thinking.clone()));
            let signature = match buffers {
                Some((text, thinking)) => {
                    Some((text.read().await.len(), thinking.read().await.len()))
                }
                None => None,
            };
            if let Some(sig) = &signature {
                if self.signatures.get(&chat_id) == Some(sig) {
                    continue;
                }
            }
            if let Ok(view) = capture_thread(&self.state, self.org_id, chat_id, None).await {
                if let Some(sig) = signature {
                    self.signatures.insert(chat_id, sig);
                }
                let mut content = serde_json::to_value(&view).expect("view serializes");
                content["seq"] = json!(0);
                if self.views.get(&chat_id) != Some(&content) {
                    self.views.insert(chat_id, content);
                    let _ = self.broadcast.send(view);
                }
            }
        }
    }

    async fn handle_notification(&mut self, notification: sqlx::postgres::PgNotification) {
        if notification.channel() == "guild_thread_committed" {
            if let Ok(chat) = notification.payload().parse::<Uuid>() {
                self.views.remove(&chat);
                self.signatures.remove(&chat);
            }
            self.refresh_bindings().await;
            self.publish_views().await;
            return;
        }
        if notification.channel() == crate::store::events::CHAT_STATUS_CHANNEL {
            let Ok(payload) = serde_json::from_str::<Value>(notification.payload()) else {
                return;
            };
            if payload["org_id"].as_str() != Some(&self.org_id.to_string())
                || payload["user_id"].as_str() != Some(&self.user_id.to_string())
            {
                return;
            }
            let (Some(chat_id), Some(generating)) = (
                payload["chat_id"].as_str().and_then(|id| id.parse().ok()),
                payload["generating"].as_bool(),
            ) else {
                return;
            };
            let _ = self.broadcast.send(WsServerMsg::ChatStatus {
                chat_id,
                generating,
            });
            return;
        }
        let Ok(payload) = notification.payload().parse::<Value>() else {
            return;
        };
        if payload["org_id"].as_str() != Some(&self.org_id.to_string()) {
            return;
        }
        let Some(event_id) = payload["event_id"]
            .as_str()
            .and_then(|id| id.parse::<Uuid>().ok())
        else {
            return;
        };
        match self.store.events().get(self.org_id, event_id).await {
            Ok(Some(event)) => {
                let _ = self.broadcast.send(WsServerMsg::OrgEvent {
                    event: serde_json::to_value(event).expect("event serializes"),
                });
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(error = ?error, "feed org-event lookup failed"),
        }
    }
}

pub(crate) async fn prepare_generation(
    state: &AppState,
    user: &AuthUser,
) -> Result<(), crate::http::error::ApiError> {
    let _subscription = feed_of(state, user);
    let prepare = state
        .feeds
        .lock()
        .unwrap()
        .get(&user.0.id)
        .unwrap()
        .prepare
        .clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    prepare
        .send(tx)
        .map_err(|_| crate::http::error::ApiError::internal("feed stopped"))?;
    tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| crate::http::error::ApiError::internal("feed bootstrap timed out"))?
        .map_err(|_| crate::http::error::ApiError::internal("feed stopped"))
}

/// The only subscription path for a user's singleton feed. This replaces
/// the plan's `FeedHandle` return contract: it atomically creates and returns
/// a receiver while the registry entry is locked, so the task stays alive
/// until the caller owns a live subscription.
pub fn feed_of(state: &AppState, user: &AuthUser) -> broadcast::Receiver<WsServerMsg> {
    let (prepare_tx, prepare_rx) = tokio::sync::mpsc::unbounded_channel();
    let (receiver, start, broadcast) = {
        let mut feeds = state.feeds.lock().unwrap();
        match feeds.get(&user.0.id) {
            Some(handle) => (
                handle.broadcast.subscribe(),
                false,
                handle.broadcast.clone(),
            ),
            None => {
                let (broadcast, _) = broadcast::channel(1024);
                let receiver = broadcast.subscribe();
                feeds.insert(
                    user.0.id,
                    FeedHandle {
                        broadcast: broadcast.clone(),
                        prepare: prepare_tx,
                    },
                );
                (receiver, true, broadcast)
            }
        }
    };
    if start {
        tokio::spawn(feed_task(
            state.clone(),
            user.0.org_id,
            user.0.id,
            broadcast,
            prepare_rx,
        ));
    }
    receiver
}

/// Removes only the current feed after rechecking its receiver count while
/// holding the map lock. A concurrent subscriber either keeps this task or
/// creates a replacement feed after this task exits.
fn remove_feed_if_unused(
    state: &AppState,
    user_id: Uuid,
    broadcast: &broadcast::Sender<WsServerMsg>,
) -> bool {
    if broadcast.receiver_count() != 0 {
        return false;
    }
    let mut feeds = state.feeds.lock().unwrap();
    if broadcast.receiver_count() != 0 {
        return false;
    }
    let is_current = feeds
        .get(&user_id)
        .is_some_and(|handle| handle.broadcast.same_channel(broadcast));
    if is_current {
        feeds.remove(&user_id);
    }
    true
}

async fn feed_task(
    state: AppState,
    org_id: Uuid,
    user_id: Uuid,
    broadcast: broadcast::Sender<WsServerMsg>,
    mut prepare: tokio::sync::mpsc::UnboundedReceiver<tokio::sync::oneshot::Sender<()>>,
) {
    let store = loop {
        if remove_feed_if_unused(&state, user_id, &broadcast) {
            return;
        }
        match state.store().await {
            Ok(store) => break store,
            Err(error) => {
                tracing::warn!(error = ?error, %user_id, "feed store connection failed");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    };
    let mut feed = Feed::new(state.clone(), store, org_id, user_id, broadcast.clone());
    loop {
        if remove_feed_if_unused(&state, user_id, &broadcast) {
            return;
        }
        // Standalone connection, NOT from the pool: every live listener pins
        // one connection for its lifetime, and pool-based listeners exhaust
        // the pool so authenticated requests block on checkout.
        let mut listener =
            match sqlx::postgres::PgListener::connect(&state.config.database_url).await {
                Ok(listener) => listener,
                Err(error) => {
                    tracing::warn!(%error, %user_id, "feed listener connection failed");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
        if let Err(error) = listener.listen(crate::store::events::NOTIFY_CHANNEL).await {
            tracing::warn!(%error, %user_id, "feed event subscription failed");
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        }
        if let Err(error) = listener
            .listen(crate::store::events::CHAT_STATUS_CHANNEL)
            .await
        {
            tracing::warn!(%error, %user_id, "feed status subscription failed");
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        }
        if listener.listen("guild_thread_committed").await.is_err() {
            continue;
        }
        feed.views.clear();
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                Some(ready) = prepare.recv() => {
                    feed.refresh_bindings().await;
                    feed.poll().await;
                    let _ = ready.send(());
                },
                notification = listener.recv() => match notification {
                    Ok(notification) => feed.handle_notification(notification).await,
                    Err(error) => {
                        tracing::warn!(%error, %user_id, "feed listener disconnected");
                        break;
                    }
                },
                _ = tick.tick() => {
                    if remove_feed_if_unused(&state, user_id, &broadcast) {
                        return;
                    }
                    feed.poll().await;
                },
            }
        }
    }
}

/// Sends feed broadcasts through a socket's dedicated outbound queue.
pub(crate) fn forward_to_socket(
    mut receiver: broadcast::Receiver<WsServerMsg>,
    sink: SocketSink,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(message) => {
                    if sink.send(message).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if sink
                        .send(WsServerMsg::Error {
                            message: "frames dropped — resync".into(),
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    })
}

/// Returns the same thread-list payload as `GET /api/v1/chats`.
pub(crate) async fn thread_list(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<Value>, crate::http::error::ApiError> {
    let store = state.store().await?;
    let chats = store.chats().list_chats(org_id, user_id).await?;
    Ok(chats
        .into_iter()
        .map(|chat| {
            let mut chat = protocol::api::Chat::from(chat);
            chat.machine_online = chat
                .machine_id
                .as_deref()
                .map(|mid| state.hub.machine_online(mid))
                .unwrap_or(false);
            serde_json::to_value(chat).expect("chat serializes")
        })
        .collect())
}

/// Emits one chat's durable history and in-flight state directly to a socket.
pub async fn run_sync(state: &AppState, user: &AuthUser, chat_id: Uuid, sink: &SocketSink) {
    if sink.start_sync().await.is_err() {
        return;
    }
    run_sync_started(state, user, chat_id, sink).await;
}

/// Completes a sync whose gate was opened by the socket reader.
pub(crate) async fn run_sync_started(
    state: &AppState,
    user: &AuthUser,
    chat_id: Uuid,
    sink: &SocketSink,
) {
    let _ = sink.send(WsServerMsg::SyncBegin { chat_id }).await;
    match capture_thread(state, user.0.org_id, chat_id, Some(user)).await {
        Ok(snapshot) => {
            let _ = sink.send(snapshot).await;
        }
        Err(error) => {
            let _ = sink
                .send(WsServerMsg::Error {
                    message: error.message,
                })
                .await;
        }
    }
    let _ = sink.send(WsServerMsg::SyncDone { chat_id }).await;
}

/// History and the unpersisted model buffers are one atomic view. The worker
/// holds these same buffer locks while committing and clearing an assistant
/// step. Capture order and watermark allocation share an async mutex.
async fn capture_thread(
    state: &AppState,
    org: Uuid,
    chat_id: Uuid,
    user: Option<&AuthUser>,
) -> Result<WsServerMsg, crate::http::error::ApiError> {
    let _capture = state.thread_sync.lock().await;
    let store = state.store().await?;
    if let Some(user) = user {
        store.chats().get_chat(org, chat_id, &user.0).await?;
    }
    let buffers = {
        let generations = state.generations.lock().unwrap();
        generations
            .get(&chat_id)
            .map(|g| (g.text.clone(), g.thinking.clone()))
    };
    let (text, thinking, events) = if let Some((text, thinking)) = buffers {
        let text = text.read().await;
        let thinking = thinking.read().await;
        let events = store.thread().list_events(org, chat_id).await?;
        (text.clone(), thinking.clone(), events)
    } else {
        (
            String::new(),
            String::new(),
            store.thread().list_events(org, chat_id).await?,
        )
    };
    let generating = state.generations.lock().unwrap().contains_key(&chat_id);
    let seq = store.thread().watermark().await?;
    Ok(WsServerMsg::ThreadState {
        chat_id,
        seq,
        generating,
        text,
        thinking,
        events: events
            .into_iter()
            .map(|row| serde_json::to_value(row).expect("thread row serializes"))
            .collect(),
    })
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use crate::http::auth::AuthUser;
    use crate::http::gateway::ensure_generation;
    use crate::http::hub::Member;
    use crate::http::ws::{socket_channel, SocketGate, SocketOutput};
    use crate::test_support::{
        note_client_tool, test_state_with_mock_ingress, MockIngress, TestState,
    };
    use protocol::api::{StreamEvent, ThreadEvent};
    use protocol::ws::WsServerMsg;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    async fn setup() -> (
        TestState,
        AuthUser,
        crate::store::chats::ChatRow,
        MockIngress,
    ) {
        let (ts, ingress) = test_state_with_mock_ingress().await;
        let store = ts.store();
        let user_id = store
            .identity()
            .ensure_bootstrap_admin("feed@example.test", "hunter226")
            .await
            .unwrap();
        let user = store
            .identity()
            .authenticate("feed@example.test", "hunter226")
            .await
            .unwrap();
        assert_eq!(user.id, user_id);
        let chat = store
            .chats()
            .create_chat(user.org_id, user.id, Some("feed test"))
            .await
            .unwrap();
        (ts, AuthUser(user), chat, ingress)
    }

    async fn receive(sink: &mut mpsc::UnboundedReceiver<SocketOutput>) -> WsServerMsg {
        loop {
            let output = tokio::time::timeout(Duration::from_secs(1), sink.recv())
                .await
                .expect("frame timed out")
                .expect("sink closed");
            if let SocketOutput::Message(message) = output {
                return message;
            }
        }
    }

    #[tokio::test]
    async fn sync_returns_history_and_in_flight_snapshot() {
        let (ts, user, chat, _ingress) = setup().await;
        let store = ts.store();
        store
            .thread()
            .append_event(
                chat.id,
                &ThreadEvent::UserMessage {
                    content: "hello".into(),
                    attachments: Vec::new(),
                },
            )
            .await
            .unwrap();
        store
            .thread()
            .append_event(
                chat.id,
                &ThreadEvent::SystemMessage {
                    content: "system".into(),
                },
            )
            .await
            .unwrap();

        let (_, text, _) = ensure_generation(&ts.state, chat.id);
        *text.write().await = "partial".into();
        note_client_tool(&ts.state, chat.id, "call-1", "read_file", "{}", "m1");

        let (sink, mut frames) = socket_channel();
        run_sync(&ts.state, &user, chat.id, &sink).await;

        assert!(
            matches!(receive(&mut frames).await, WsServerMsg::SyncBegin { chat_id } if chat_id == chat.id)
        );
        match receive(&mut frames).await {
            WsServerMsg::ThreadState {
                chat_id,
                seq,
                events,
                text,
                generating,
                ..
            } => {
                assert_eq!(chat_id, chat.id);
                assert_eq!(events.len(), 2);
                assert!(seq > events.last().unwrap()["seq"].as_i64().unwrap());
                assert_eq!(text, "partial");
                assert!(generating);
            }
            other => panic!("expected atomic thread state, got {other:?}"),
        }
        assert!(
            matches!(receive(&mut frames).await, WsServerMsg::SyncDone { chat_id } if chat_id == chat.id)
        );
    }

    #[tokio::test]
    async fn token_during_sync_has_a_newer_authoritative_watermark() {
        let (ts, user, chat, _) = setup().await;
        let (_, text, _) = ensure_generation(&ts.state, chat.id);
        *text.write().await = "before".into();
        let before = capture_thread(&ts.state, user.0.org_id, chat.id, Some(&user))
            .await
            .unwrap();
        *text.write().await += " during sync";
        let after = capture_thread(&ts.state, user.0.org_id, chat.id, Some(&user))
            .await
            .unwrap();
        let WsServerMsg::ThreadState {
            seq: first,
            text: first_text,
            ..
        } = before
        else {
            panic!()
        };
        let WsServerMsg::ThreadState {
            seq: second,
            text: second_text,
            ..
        } = after
        else {
            panic!()
        };
        assert!(second > first);
        assert_eq!(first_text, "before");
        assert_eq!(second_text, "before during sync");
    }

    #[tokio::test]
    async fn reconnect_while_awaiting_approval_does_not_replay_persisted_text() {
        let (ts, user, chat, _) = setup().await;
        let (_, text, thinking) = ensure_generation(&ts.state, chat.id);
        *text.write().await = "proposal".into();
        *thinking.write().await = "reason".into();
        let event = serde_json::from_value::<ThreadEvent>(
            json!({"type":"assistant_message", "turn":1, "step":0,
            "blocks":[{"type":"text", "text":"proposal"}], "usage":{}, "model":"test"}),
        )
        .unwrap();
        crate::http::gateway::persist_assistant_step(&ts.state, chat.id, &event)
            .await
            .unwrap();
        ts.store()
            .thread()
            .append_event(
                chat.id,
                &ThreadEvent::ApprovalRequest {
                    call_id: "approval".into(),
                    name: "execute".into(),
                    arguments: "{}".into(),
                },
            )
            .await
            .unwrap();
        let view = capture_thread(&ts.state, user.0.org_id, chat.id, Some(&user))
            .await
            .unwrap();
        let WsServerMsg::ThreadState {
            text,
            thinking,
            events,
            generating,
            ..
        } = view
        else {
            panic!()
        };
        assert!(text.is_empty() && thinking.is_empty());
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["event"]["type"], "approval_request");
        assert!(generating);
    }

    #[tokio::test]
    async fn feed_fans_out_to_all_members() {
        let (ts, user, chat, _ingress) = setup().await;
        let store = ts.store();
        store
            .chats()
            .set_machine(user.0.org_id, chat.id, Some("m1"), Some("Desk"))
            .await
            .unwrap();
        let generation_tx = ensure_generation(&ts.state, chat.id).0;
        let (broadcast, _) = tokio::sync::broadcast::channel(16);
        let mut feed = Feed::new(
            ts.state.clone(),
            Arc::new(store),
            user.0.org_id,
            user.0.id,
            broadcast.clone(),
        );
        feed.poll().await;

        let (member_one, mut member_one_rx) = socket_channel();
        let (member_two, mut member_two_rx) = socket_channel();
        let (machine, mut machine_rx) = socket_channel();
        for sink in [&member_one, &member_two] {
            ts.state
                .hub
                .register_member(Member {
                    conn_id: Uuid::now_v7(),
                    user_id: user.0.id,
                    org_id: user.0.org_id,
                    sink: sink.clone(),
                    label: None,
                })
                .unwrap();
        }
        ts.state
            .hub
            .register_machine(
                Member {
                    conn_id: Uuid::now_v7(),
                    user_id: user.0.id,
                    org_id: user.0.org_id,
                    sink: machine.clone(),
                    label: Some("Desk".into()),
                },
                "m1",
            )
            .await
            .unwrap();
        let forwarders = [
            forward_to_socket(broadcast.subscribe(), member_one),
            forward_to_socket(broadcast.subscribe(), member_two),
            forward_to_socket(broadcast.subscribe(), machine),
        ];

        generation_tx
            .send(StreamEvent::Delta {
                content: "live".into(),
            })
            .unwrap();
        feed.poll().await;

        for sink in [&mut member_one_rx, &mut member_two_rx, &mut machine_rx] {
            assert!(matches!(
                receive(sink).await,
                WsServerMsg::LiveFrame {
                    chat_id,
                    machine_id: Some(machine_id),
                    event: StreamEvent::Delta { content },
                    ..
                } if chat_id == chat.id && machine_id == "m1" && content == "live"
            ));
        }
        for forwarder in forwarders {
            forwarder.abort();
        }
    }

    #[test]
    fn unused_feed_is_removed_without_racing_a_new_subscription() {
        let state = AppState::from_config(crate::config::Config::test_config());
        let user = Uuid::now_v7();
        let (broadcast, _) = broadcast::channel(4);
        let handle = FeedHandle {
            prepare: tokio::sync::mpsc::unbounded_channel().0,
            broadcast: broadcast.clone(),
        };
        state.feeds.lock().unwrap().insert(user, handle);

        let receiver = broadcast.subscribe();
        assert!(!remove_feed_if_unused(&state, user, &broadcast));
        assert!(state.feeds.lock().unwrap().contains_key(&user));
        drop(receiver);

        assert!(remove_feed_if_unused(&state, user, &broadcast));
        assert!(!state.feeds.lock().unwrap().contains_key(&user));
    }

    #[tokio::test]
    async fn feed_of_returns_an_already_registered_receiver() {
        let state = AppState::from_config(crate::config::Config::test_config());
        let user = AuthUser(crate::store::identity::UserRow {
            id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            email: "feed@example.com".into(),
            role: "member".into(),
            identity_type: "managed".into(),
            display_name: None,
            avatar_url: None,
        });
        let receiver = feed_of(&state, &user);
        let broadcast = state
            .feeds
            .lock()
            .unwrap()
            .get(&user.0.id)
            .expect("feed is registered")
            .broadcast
            .clone();
        assert_eq!(broadcast.receiver_count(), 1);
        drop(receiver);
        assert!(remove_feed_if_unused(&state, user.0.id, &broadcast));
    }

    #[test]
    fn sync_gate_defers_live_frames_until_sync_done() {
        let chat_id = Uuid::now_v7();
        let live = WsServerMsg::LiveFrame {
            generation_id: Uuid::nil(),
            seq: 1,
            chat_id,
            machine_id: None,
            event: StreamEvent::Delta {
                content: "live".into(),
            },
        };
        let mut gate = SocketGate::default();
        assert!(gate.push(SocketOutput::SyncStart).is_empty());
        assert!(gate.push(SocketOutput::Message(live.clone())).is_empty());
        assert_eq!(
            gate.push(SocketOutput::Message(WsServerMsg::SyncBegin { chat_id })),
            vec![WsServerMsg::SyncBegin { chat_id }]
        );
        assert_eq!(
            gate.push(SocketOutput::Message(WsServerMsg::SyncDone { chat_id })),
            vec![WsServerMsg::SyncDone { chat_id }, live]
        );
    }

    #[tokio::test]
    async fn lagged_feed_receiver_emits_a_resync_error() {
        let (broadcast, _) = broadcast::channel(1);
        let receiver = broadcast.subscribe();
        for _ in 0..4 {
            let _ = broadcast.send(WsServerMsg::Hello);
        }
        let (sink, mut sink_rx) = socket_channel();
        let forwarder = forward_to_socket(receiver, sink);
        assert!(matches!(
            receive(&mut sink_rx).await,
            WsServerMsg::Error { message } if message == "frames dropped — resync"
        ));
        forwarder.abort();
    }

    #[tokio::test]
    async fn dispatch_to_offline_machine_fails_fast_without_a_feed() {
        let (ts, _user, chat, ingress) = setup().await;
        ensure_generation(&ts.state, chat.id);
        note_client_tool(&ts.state, chat.id, "call-1", "execute", "{}", "offline");
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !ingress.requests.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let sent = ingress.requests.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].0,
            format!("/ChatRunner/{}/complete_tool/send", chat.id)
        );
        assert_eq!(sent[0].1["call_id"], "call-1");
        assert_eq!(sent[0].1["is_error"], true);
    }
}
