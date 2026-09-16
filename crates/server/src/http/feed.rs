use crate::http::auth::AuthUser;
use crate::http::internal::restate_send_one_way;
use crate::http::ws::SocketSink;
use crate::state::AppState;
use crate::store::Store;
use protocol::api::{StreamEvent, ToolExecutor};
use protocol::ws::WsServerMsg;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Live frames shared by every connected socket of one user.
#[derive(Clone)]
pub struct FeedHandle {
    pub broadcast: broadcast::Sender<WsServerMsg>,
}

#[derive(Clone)]
struct ChatBinding {
    machine_id: Option<String>,
    machine_label: Option<String>,
}

/// One user's generation subscriptions and notification fan-out state.
struct Feed {
    state: AppState,
    store: Arc<Store>,
    org_id: Uuid,
    user_id: Uuid,
    broadcast: broadcast::Sender<WsServerMsg>,
    chats: HashMap<Uuid, ChatBinding>,
    subs: HashMap<Uuid, broadcast::Receiver<StreamEvent>>,
    seen_calls: HashSet<String>,
    slow_tick: u32,
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
            seen_calls: HashSet::new(),
            // Refresh bindings on the first tick.
            slow_tick: 3,
        }
    }

    fn forwardable(event: &StreamEvent) -> bool {
        !matches!(
            event,
            StreamEvent::ToolCallDelta { .. } | StreamEvent::ToolCallDone { .. }
        )
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
                                machine_label: chat.machine_label,
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

    /// Snapshots are read before subscriptions are created. A frame emitted
    /// between those operations can arrive in the next poll, so this is a
    /// tiny at-least-once overlap rather than a delta-before-snapshot reorder.
    async fn poll(&mut self) {
        self.slow_tick = (self.slow_tick + 1) % 4;
        if self.slow_tick == 0 {
            self.refresh_bindings().await;
        }

        let mut frames: Vec<(Uuid, ChatBinding, StreamEvent)> = Vec::new();
        let mut subs = std::mem::take(&mut self.subs);
        let mut snapshots: Vec<(
            Uuid,
            ChatBinding,
            Arc<tokio::sync::RwLock<String>>,
            Arc<tokio::sync::RwLock<String>>,
            Vec<(String, String, String)>,
        )> = Vec::new();

        {
            let generations = self.state.generations.lock().unwrap();
            for (chat_id, generation) in generations.iter() {
                let Some(binding) = self.chats.get(chat_id).cloned() else {
                    continue;
                };
                if subs.contains_key(chat_id) {
                    continue;
                }
                let mut pending = Vec::new();
                for (call_id, tool) in generation.pending_tools.lock().unwrap().iter() {
                    if self.seen_calls.insert(call_id.clone()) {
                        pending.push((call_id.clone(), tool.name.clone(), tool.arguments.clone()));
                    }
                }
                snapshots.push((
                    *chat_id,
                    binding,
                    generation.text.clone(),
                    generation.thinking.clone(),
                    pending,
                ));
            }
        }

        // Send snapshots before creating receivers. The next lock attaches
        // only after all accumulated buffers have been copied.
        for (chat_id, binding, text, thinking, pending) in &snapshots {
            let text = text.read().await.clone();
            if !text.is_empty() {
                frames.push((
                    *chat_id,
                    binding.clone(),
                    StreamEvent::Delta { content: text },
                ));
            }
            let thinking = thinking.read().await.clone();
            if !thinking.is_empty() {
                frames.push((
                    *chat_id,
                    binding.clone(),
                    StreamEvent::ThinkingDelta { content: thinking },
                ));
            }
            for (call_id, name, arguments) in pending {
                frames.push((
                    *chat_id,
                    binding.clone(),
                    StreamEvent::ToolStarted {
                        call_id: call_id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                        executor: ToolExecutor::Client,
                        kind: None,
                    },
                ));
            }
        }

        let mut live = Vec::new();
        {
            let generations = self.state.generations.lock().unwrap();
            for (chat_id, generation) in generations.iter() {
                if !self.chats.contains_key(chat_id) {
                    continue;
                }
                live.push(*chat_id);
                if !subs.contains_key(chat_id) {
                    subs.insert(*chat_id, generation.tx.subscribe());
                }
            }
            for (chat_id, receiver) in subs.iter_mut() {
                let Some(binding) = self.chats.get(chat_id).cloned() else {
                    continue;
                };
                loop {
                    match receiver.try_recv() {
                        Ok(event) if Self::forwardable(&event) => {
                            if let StreamEvent::ToolStarted { call_id, .. } = &event {
                                if !self.seen_calls.insert(call_id.clone()) {
                                    continue;
                                }
                            }
                            frames.push((*chat_id, binding.clone(), event));
                        }
                        Ok(_) => {}
                        Err(broadcast::error::TryRecvError::Empty)
                        | Err(broadcast::error::TryRecvError::Closed) => break,
                        Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                    }
                }
            }
        }
        self.subs = subs;
        self.subs.retain(|chat_id, _| live.contains(chat_id));

        for (chat_id, binding, event) in frames {
            self.emit_frame(chat_id, binding, event).await;
        }
    }

    async fn emit_frame(&self, chat_id: Uuid, binding: ChatBinding, event: StreamEvent) {
        let offline_tool = match &event {
            StreamEvent::ToolStarted {
                call_id,
                name,
                executor: ToolExecutor::Client,
                ..
            } => binding.machine_id.as_ref().and_then(|machine_id| {
                (!self.state.hub.machine_online(machine_id)).then(|| {
                    (
                        call_id.clone(),
                        name.clone(),
                        machine_id.clone(),
                        binding
                            .machine_label
                            .clone()
                            .unwrap_or_else(|| machine_id.clone()),
                    )
                })
            }),
            _ => None,
        };
        let machine_id = binding.machine_id.clone();
        let _ = self.broadcast.send(WsServerMsg::LiveFrame {
            chat_id,
            machine_id: machine_id.clone(),
            event,
        });

        let Some((call_id, name, _machine_id, label)) = offline_tool else {
            return;
        };
        let content = format!("client tool {name} aborted: the bound machine '{label}' is offline");
        if let Err(error) = restate_send_one_way(
            &self.state,
            "ChatRunner",
            &format!("{chat_id}/complete_tool"),
            json!({
                "call_id": call_id,
                "content": content,
                "is_error": true,
            }),
        )
        .await
        {
            tracing::warn!(error = ?error, %chat_id, "offline client-tool completion failed");
        }
        let _ = self.broadcast.send(WsServerMsg::LiveFrame {
            chat_id,
            machine_id,
            event: StreamEvent::ToolCompleted {
                call_id,
                name,
                content,
                is_error: true,
            },
        });
    }

    async fn handle_notification(&self, notification: sqlx::postgres::PgNotification) {
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

fn spawn_feed(
    state: AppState,
    org_id: Uuid,
    user_id: Uuid,
    broadcast: broadcast::Sender<WsServerMsg>,
) {
    tokio::spawn(feed_task(state, org_id, user_id, broadcast));
}

/// Returns the singleton live feed for this user and starts it on first use.
pub async fn feed_of(state: &AppState, user: &AuthUser) -> FeedHandle {
    let (handle, start) = {
        let mut feeds = state.feeds.lock().unwrap();
        match feeds.get(&user.0.id) {
            Some(handle) => (handle.clone(), false),
            None => {
                let (broadcast, _) = broadcast::channel(1024);
                let handle = FeedHandle { broadcast };
                feeds.insert(user.0.id, handle.clone());
                (handle, true)
            }
        }
    };
    if start {
        spawn_feed(
            state.clone(),
            user.0.org_id,
            user.0.id,
            handle.broadcast.clone(),
        );
    }
    handle
}

/// Subscribes while the feed map is locked, so a retiring task cannot remove
/// the handle between lookup and receiver creation.
pub(crate) fn subscribe(state: &AppState, user: &AuthUser) -> broadcast::Receiver<WsServerMsg> {
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
                    },
                );
                (receiver, true, broadcast)
            }
        }
    };
    if start {
        spawn_feed(state.clone(), user.0.org_id, user.0.id, broadcast);
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
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
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
    user: &AuthUser,
) -> Result<Vec<Value>, crate::http::error::ApiError> {
    let store = state.store().await?;
    let chats = store.chats().list_chats(user.0.org_id, user.0.id).await?;
    Ok(chats
        .into_iter()
        .map(|chat| serde_json::to_value(protocol::api::Chat::from(chat)).expect("chat serializes"))
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
    let result = async {
        let store = state.store().await?;
        let chat = store
            .chats()
            .get_chat(user.0.org_id, chat_id, &user.0)
            .await?;
        let history = store.thread().list_events(user.0.org_id, chat_id).await?;
        Ok::<_, crate::http::error::ApiError>((chat, history))
    }
    .await;
    let (chat, history) = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = sink
                .send(WsServerMsg::Error {
                    message: error.message,
                })
                .await;
            let _ = sink.abort_sync().await;
            return;
        }
    };

    let snapshot = {
        let generations = state.generations.lock().unwrap();
        generations.get(&chat_id).map(|generation| {
            let pending = generation
                .pending_tools
                .lock()
                .unwrap()
                .iter()
                .map(|(call_id, tool)| (call_id.clone(), tool.name.clone(), tool.arguments.clone()))
                .collect::<Vec<_>>();
            (
                generation.text.clone(),
                generation.thinking.clone(),
                pending,
            )
        })
    };

    if sink.send(WsServerMsg::SyncBegin { chat_id }).await.is_err() {
        return;
    }
    let events = history
        .into_iter()
        .map(|event| serde_json::to_value(event).expect("thread event serializes"))
        .collect();
    if sink
        .send(WsServerMsg::History { chat_id, events })
        .await
        .is_err()
    {
        return;
    }
    if let Some((text, thinking, pending)) = snapshot {
        let machine_id = chat.machine_id;
        let text = text.read().await.clone();
        if !text.is_empty()
            && sink
                .send(WsServerMsg::SnapshotFrame {
                    chat_id,
                    machine_id: machine_id.clone(),
                    event: StreamEvent::Delta { content: text },
                })
                .await
                .is_err()
        {
            return;
        }
        let thinking = thinking.read().await.clone();
        if !thinking.is_empty()
            && sink
                .send(WsServerMsg::SnapshotFrame {
                    chat_id,
                    machine_id: machine_id.clone(),
                    event: StreamEvent::ThinkingDelta { content: thinking },
                })
                .await
                .is_err()
        {
            return;
        }
        for (call_id, name, arguments) in pending {
            if sink
                .send(WsServerMsg::SnapshotFrame {
                    chat_id,
                    machine_id: machine_id.clone(),
                    event: StreamEvent::ToolStarted {
                        call_id,
                        name,
                        arguments,
                        executor: ToolExecutor::Client,
                        kind: None,
                    },
                })
                .await
                .is_err()
            {
                return;
            }
        }
    }
    let _ = sink.send(WsServerMsg::SyncDone { chat_id }).await;
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

    async fn receive(sink: &mut mpsc::Receiver<SocketOutput>) -> WsServerMsg {
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

        let (sink, mut frames) = socket_channel(16);
        run_sync(&ts.state, &user, chat.id, &sink).await;

        assert!(
            matches!(receive(&mut frames).await, WsServerMsg::SyncBegin { chat_id } if chat_id == chat.id)
        );
        match receive(&mut frames).await {
            WsServerMsg::History { chat_id, events } => {
                assert_eq!(chat_id, chat.id);
                assert_eq!(events.len(), 2);
            }
            other => panic!("expected history, got {other:?}"),
        }
        assert!(matches!(
            receive(&mut frames).await,
            WsServerMsg::SnapshotFrame {
                chat_id,
                event: StreamEvent::Delta { content },
                ..
            } if chat_id == chat.id && content == "partial"
        ));
        assert!(matches!(
            receive(&mut frames).await,
            WsServerMsg::SnapshotFrame {
                chat_id,
                event: StreamEvent::ToolStarted { call_id, .. },
                ..
            } if chat_id == chat.id && call_id == "call-1"
        ));
        assert!(
            matches!(receive(&mut frames).await, WsServerMsg::SyncDone { chat_id } if chat_id == chat.id)
        );
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

        let (member_one, mut member_one_rx) = socket_channel(4);
        let (member_two, mut member_two_rx) = socket_channel(4);
        let (machine, mut machine_rx) = socket_channel(4);
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

    #[test]
    fn sync_gate_defers_live_frames_until_sync_done() {
        let chat_id = Uuid::now_v7();
        let live = WsServerMsg::LiveFrame {
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
        let (sink, mut sink_rx) = socket_channel(4);
        let forwarder = forward_to_socket(receiver, sink);
        assert!(matches!(
            receive(&mut sink_rx).await,
            WsServerMsg::Error { message } if message == "frames dropped — resync"
        ));
        forwarder.abort();
    }

    #[tokio::test]
    async fn dispatch_to_offline_machine_fails_fast() {
        let (ts, user, chat, ingress) = setup().await;
        let store = ts.store();
        store
            .chats()
            .set_machine(user.0.org_id, chat.id, Some("mX"), Some("Offline desk"))
            .await
            .unwrap();
        ensure_generation(&ts.state, chat.id);
        note_client_tool(
            &ts.state,
            chat.id,
            "call-1",
            "execute",
            "{\"cmd\":\"pwd\"}",
            "mX",
        );

        let (broadcast, _) = tokio::sync::broadcast::channel(16);
        let mut feed = Feed::new(
            ts.state.clone(),
            Arc::new(store),
            user.0.org_id,
            user.0.id,
            broadcast.clone(),
        );
        let (sink, mut sink_rx) = socket_channel(4);
        let forwarder = forward_to_socket(broadcast.subscribe(), sink);
        feed.poll().await;

        assert!(matches!(
            receive(&mut sink_rx).await,
            WsServerMsg::LiveFrame {
                chat_id,
                event: StreamEvent::ToolStarted { call_id, .. },
                ..
            } if chat_id == chat.id && call_id == "call-1"
        ));
        assert!(matches!(
            receive(&mut sink_rx).await,
            WsServerMsg::LiveFrame {
                chat_id,
                event: StreamEvent::ToolCompleted { call_id, is_error: true, content, .. },
                ..
            } if chat_id == chat.id
                && call_id == "call-1"
                && content == "client tool execute aborted: the bound machine 'Offline desk' is offline"
        ));
        forwarder.abort();

        let sent = ingress.requests.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].0,
            format!("/ChatRunner/{}/complete_tool/send", chat.id)
        );
        assert_eq!(
            sent[0].1,
            serde_json::json!({
                "call_id": "call-1",
                "content": "client tool execute aborted: the bound machine 'Offline desk' is offline",
                "is_error": true,
            })
        );
    }
}
