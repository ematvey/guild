//! Shared request state: config + lazily-connected record store, usage sink,
//! and the per-chat generation table (spec §4).

use crate::config::Config;
use crate::http::error::ApiError;
use crate::http::hub::Hub;
use crate::s3::SharedObjectStore;
use crate::store::Store;
use crate::usage::SharedUsageSink;
use crate::worker::mcp_pool::McpPool;
use protocol::api::StreamEvent;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{OnceCell, RwLock};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    db: Arc<OnceCell<Arc<Store>>>,
    usage: Arc<OnceCell<SharedUsageSink>>,
    objects: Arc<OnceCell<SharedObjectStore>>,
    /// Server-side generations in flight, keyed by chat. Detached from any
    /// client connection: a disconnect does not stop them; clients reconcile
    /// through authoritative WebSocket state. All access goes through the
    /// table's verbs.
    pub generations: GenerationTable,
    /// Cached MCP client connections for integration plugins (outside the
    /// Restate journal — reconnecting on replay is safe, spec §8).
    pub mcp_pool: Arc<McpPool>,
    pub ws_tickets: crate::http::ws::TicketStore,
    pub hub: Arc<Hub>,
    /// One live-frame feed per user, shared by all of their sockets.
    pub feeds: Arc<Mutex<HashMap<Uuid, crate::http::feed::FeedHandle>>>,
    /// Machine-fetched AGENTS.md chains per project folder (web parity, spec
    /// 2026-09-18 unification §4 phase 5a): the machine channel exposes no
    /// mtime verb, so freshness is a TTL bound instead. Outside the Restate
    /// journal — a cache miss just re-dispatches the read.
    pub agents_md_cache: Arc<Mutex<HashMap<String, (std::time::Instant, String)>>>,
}

impl AppState {
    pub fn from_config(cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            db: Arc::new(OnceCell::new()),
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: GenerationTable::new(),
            mcp_pool: Arc::new(McpPool::new()),
            ws_tickets: Default::default(),
            hub: Arc::new(Hub::default()),
            feeds: Arc::new(Mutex::new(HashMap::new())),
            agents_md_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Lazily connects to Postgres on first use; shared thereafter. The
    /// legacy-secret migration runs once with the store.
    pub async fn store(&self) -> Result<Arc<Store>, ApiError> {
        self.db
            .get_or_try_init(|| async {
                let s = Store::connect(&self.config.database_url)
                    .await
                    .map_err(ApiError::from)?;
                if let Ok(master) = self.config.master_key() {
                    if let Err(e) =
                        crate::integrations::migrate_legacy_credential_secrets(&s, &master).await
                    {
                        tracing::warn!("legacy credential-secret migration failed: {e:?}");
                    }
                }
                Ok(Arc::new(s))
            })
            .await
            .cloned()
    }

    pub(crate) fn usage_cell(&self) -> &OnceCell<SharedUsageSink> {
        &self.usage
    }

    pub(crate) fn objects_cell(&self) -> &OnceCell<SharedObjectStore> {
        &self.objects
    }

    /// Test constructor: state pre-seeded with an existing store.
    #[cfg(feature = "test-support")]
    pub fn with_store(store: Arc<Store>, cfg: Config) -> Self {
        Self {
            config: Arc::new(cfg),
            db: {
                let cell = OnceCell::new();
                cell.set(store).unwrap_or_else(|_| panic!("fresh OnceCell"));
                Arc::new(cell)
            },
            usage: Arc::new(OnceCell::new()),
            objects: Arc::new(OnceCell::new()),
            generations: GenerationTable::new(),
            mcp_pool: Arc::new(McpPool::new()),
            ws_tickets: Default::default(),
            hub: Arc::new(Hub::default()),
            feeds: Arc::new(Mutex::new(HashMap::new())),
            agents_md_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn machine_label(&self, machine_id: &str) -> Option<String> {
        self.hub.machine_label(machine_id)
    }

    /// True when the machine is durably registered (any pairing) to the
    /// given user or organization. DB-known, not hub-live: offline machines
    /// stay bindable.
    pub async fn machine_bindable(&self, machine_id: &str, user_id: Uuid, org_id: Uuid) -> bool {
        match self.store().await {
            Ok(store) => store
                .machines()
                .bindable(machine_id, user_id, org_id)
                .await
                .unwrap_or(false),
            Err(_) => false,
        }
    }
}

/// One suspended machine tool call.
pub struct PendingTool {
    pub name: String,
    pub arguments: String,
    /// Bound executor machine; `None` → fall back to the 5-minute timeout
    /// only.
    pub machine_id: Option<String>,
    /// Workspace folder the tool runs in (from the chat's project).
    pub workdir: Option<String>,
    pub connection_id: Option<Uuid>,
    /// Fired when the tool is resolved so the presence watcher stops.
    pub done: Arc<tokio::sync::Notify>,
}

impl Clone for PendingTool {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            arguments: self.arguments.clone(),
            machine_id: self.machine_id.clone(),
            workdir: self.workdir.clone(),
            connection_id: self.connection_id,
            done: self.done.clone(),
        }
    }
}

/// One server-side generation in flight, detached from any client connection.
/// Broadcasts generation events to command-scoped WebSocket consumers.
/// Text buffers contain only the current, unpersisted assistant step.
pub struct ActiveGeneration {
    pub id: Uuid,
    pub tx: tokio::sync::broadcast::Sender<StreamEvent>,
    pub text: Arc<RwLock<String>>,
    /// Reasoning accumulated so far in the in-flight model call, for
    /// catch-up on attach (first `thinking_delta` frame carries the buffer).
    pub thinking: Arc<RwLock<String>>,
    /// Set by the stop endpoint (and by steered sends): the ChatRunner checks
    /// it inside journaled steps, so an interrupted turn's shape stays
    /// replay-deterministic. Volatile by design — a process crash mid-turn
    /// forgets the request; the user can stop again.
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    /// Suspended machine calls and the connection responsible for each call.
    pending_tools: Mutex<HashMap<String, PendingTool>>,
}

impl ActiveGeneration {
    fn new(
        tx: tokio::sync::broadcast::Sender<StreamEvent>,
        text: Arc<RwLock<String>>,
        thinking: Arc<RwLock<String>>,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            tx,
            text,
            thinking,
            cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pending_tools: Mutex::new(HashMap::new()),
        }
    }
}

/// The stream parts of a generation, cloned out of the table. Pending tools
/// stay private to the table behind its verbs.
#[derive(Debug)]
pub struct GenerationHandle {
    pub id: Uuid,
    pub tx: tokio::sync::broadcast::Sender<StreamEvent>,
    pub text: Arc<RwLock<String>>,
    pub thinking: Arc<RwLock<String>>,
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}

/// One atomic history capture: the durable events plus the unpersisted model
/// buffers, read under the buffer locks the worker's commit also holds, with
/// the capture mutex serializing captures against each other and the
/// watermark allocated last — a `seq` never trails a captured event.
pub struct CaptureView {
    pub text: String,
    pub thinking: String,
    pub generating: bool,
    pub events: Vec<crate::store::thread::ThreadEventRow>,
    pub seq: i64,
}

/// The per-chat generation registry. Verb-only interface: callers never lock
/// the map or the pending-tool state directly.
#[derive(Clone)]
pub struct GenerationTable {
    map: Arc<Mutex<HashMap<Uuid, ActiveGeneration>>>,
    /// Serializes history captures against each other (capture order and
    /// watermark allocation share one async mutex).
    capture_lock: Arc<tokio::sync::Mutex<()>>,
}

impl GenerationTable {
    pub(crate) fn new() -> Self {
        Self {
            map: Arc::new(Mutex::new(HashMap::new())),
            capture_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Atomic check+insert: returns the generation's stream parts or 409 when
    /// a generation is already running for the chat. One lock acquisition
    /// covers both the check and the insert, so two concurrent sends cannot
    /// both start a ChatRunner invocation.
    pub fn try_begin(&self, chat_id: Uuid) -> Result<GenerationHandle, ApiError> {
        let mut map = self.map.lock().unwrap();
        if map.contains_key(&chat_id) {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "generation_in_progress",
                "a generation is already running for this chat — wait for it to finish",
            ));
        }
        let gen = Self::insert(&mut map, chat_id);
        Ok(gen)
    }

    /// Registry entry for the chat's in-flight generation, creating it if
    /// absent. Used by the Restate worker (the generation task broadcasts
    /// deltas through it) and by test support — they re-attach to a running
    /// generation instead of reserving a new one. Both roles share one
    /// process in this deployment; with split roles, live deltas only reach
    /// clients attached on the worker's process — catch-up after completion
    /// is unaffected since Postgres is the record system.
    pub fn attach(&self, chat_id: Uuid) -> GenerationHandle {
        let mut map = self.map.lock().unwrap();
        if let Some(g) = map.get(&chat_id) {
            return GenerationHandle {
                id: g.id,
                tx: g.tx.clone(),
                text: g.text.clone(),
                thinking: g.thinking.clone(),
                cancel: g.cancel.clone(),
            };
        }
        Self::insert(&mut map, chat_id)
    }

    fn insert(
        map: &mut HashMap<Uuid, ActiveGeneration>,
        chat_id: Uuid,
    ) -> GenerationHandle {
        let (tx, _) = tokio::sync::broadcast::channel::<StreamEvent>(1024);
        let gen = ActiveGeneration::new(
            tx,
            Arc::new(RwLock::new(String::new())),
            Arc::new(RwLock::new(String::new())),
        );
        let handle = GenerationHandle {
            id: gen.id,
            tx: gen.tx.clone(),
            text: gen.text.clone(),
            thinking: gen.thinking.clone(),
            cancel: gen.cancel.clone(),
        };
        map.insert(chat_id, gen);
        handle
    }

    pub fn handle(&self, chat_id: Uuid) -> Option<GenerationHandle> {
        self.map.lock().unwrap().get(&chat_id).map(|g| GenerationHandle {
            id: g.id,
            tx: g.tx.clone(),
            text: g.text.clone(),
            thinking: g.thinking.clone(),
            cancel: g.cancel.clone(),
        })
    }

    pub fn is_generating(&self, chat_id: Uuid) -> bool {
        self.map.lock().unwrap().contains_key(&chat_id)
    }

    /// The cancel flag of a chat's active generation, if one is running. The
    /// stop endpoint and steered sends set it; the ChatRunner observes it
    /// inside journaled steps.
    pub fn cancel_flag(&self, chat_id: Uuid) -> Option<Arc<std::sync::atomic::AtomicBool>> {
        self.map.lock().unwrap().get(&chat_id).map(|g| g.cancel.clone())
    }

    /// Retires the chat's generation (turn exit, invocation failure, stuck
    /// sweep).
    pub fn remove(&self, chat_id: Uuid) -> bool {
        self.map.lock().unwrap().remove(&chat_id).is_some()
    }

    /// The (chat, id, frame sender) of every tracked chat's in-flight
    /// generation, for feed subscription.
    pub fn active_streams(
        &self,
        chats: &[Uuid],
    ) -> Vec<(Uuid, Uuid, tokio::sync::broadcast::Sender<StreamEvent>)> {
        let map = self.map.lock().unwrap();
        chats
            .iter()
            .filter_map(|chat| {
                map.get(chat)
                    .map(|g| (*chat, g.id, g.tx.clone()))
            })
            .collect()
    }

    /// The replay buffers of a running generation, for delta-signature checks.
    pub fn buffers(
        &self,
        chat_id: Uuid,
    ) -> Option<(Arc<RwLock<String>>, Arc<RwLock<String>>)> {
        self.map
            .lock()
            .unwrap()
            .get(&chat_id)
            .map(|g| (g.text.clone(), g.thinking.clone()))
    }

    /// Registers a suspended tool call; returns the watcher's completion
    /// signal. With no generation running the call is not tracked (watchers
    /// see it resolved immediately) but the signal still comes back, so the
    /// caller's wiring never special-cases it.
    pub fn set_pending_tool(
        &self,
        chat_id: Uuid,
        call_id: &str,
        tool: PendingTool,
    ) -> Arc<tokio::sync::Notify> {
        let done = tool.done.clone();
        if let Some(g) = self.map.lock().unwrap().get(&chat_id) {
            g.pending_tools
                .lock()
                .unwrap()
                .insert(call_id.to_string(), tool);
        }
        done
    }

    /// Removes a suspended tool call (completed or timed out) and fires its
    /// done signal. notify_one stores a permit even if the watcher is between
    /// iterations, so it cannot miss this signal.
    pub fn clear_pending_tool(&self, chat_id: Uuid, call_id: &str) -> bool {
        let cleared = self
            .map
            .lock()
            .unwrap()
            .get(&chat_id)
            .and_then(|g| g.pending_tools.lock().unwrap().remove(call_id));
        if let Some(tool) = cleared {
            tool.done.notify_one();
            true
        } else {
            false
        }
    }

    /// Snapshot of a suspended call, for the dispatch and watcher paths.
    pub fn pending_tool(&self, chat_id: Uuid, call_id: &str) -> Option<PendingTool> {
        self.map
            .lock()
            .unwrap()
            .get(&chat_id)
            .and_then(|g| g.pending_tools.lock().unwrap().get(call_id).cloned())
    }

    /// True while the call is suspended and owned by the given connection —
    /// the ownership check a late ToolResult frame must pass.
    pub fn owns_pending_tool(&self, chat_id: Uuid, call_id: &str, connection_id: Uuid) -> bool {
        self.map
            .lock()
            .unwrap()
            .get(&chat_id)
            .is_some_and(|g| {
                g.pending_tools
                    .lock()
                    .unwrap()
                    .get(call_id)
                    .is_some_and(|tool| tool.connection_id == Some(connection_id))
            })
    }

    pub fn has_pending_tool(&self, chat_id: Uuid, call_id: &str) -> bool {
        self.map
            .lock()
            .unwrap()
            .get(&chat_id)
            .is_some_and(|g| g.pending_tools.lock().unwrap().contains_key(call_id))
    }

    /// Re-records the connection a dispatch ran on (the journaled dispatch
    /// returns it; replays restore it instead of re-dispatching).
    pub fn set_pending_tool_connection(
        &self,
        chat_id: Uuid,
        call_id: &str,
        connection_id: Option<Uuid>,
    ) {
        if let Some(g) = self.map.lock().unwrap().get(&chat_id) {
            if let Some(tool) = g.pending_tools.lock().unwrap().get_mut(call_id) {
                tool.connection_id = connection_id;
            }
        }
    }

    /// (chat, call) pairs suspended on the given machine whose recorded
    /// connection differs from the machine's live one — a connection change
    /// makes their execution outcome unknown.
    pub fn stale_machine_calls(&self, machine_id: &str, connection: Uuid) -> Vec<(Uuid, String)> {
        self.map
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(chat, g)| {
                g.pending_tools
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|(call, tool)| {
                        (tool.machine_id.as_deref() == Some(machine_id)
                            && tool.connection_id != Some(connection))
                        .then(|| (*chat, call.clone()))
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// History and the unpersisted model buffers are one atomic view. The
    /// worker holds these same buffer locks while committing and clearing an
    /// assistant step. Capture order and watermark allocation share the
    /// table's capture mutex: the buffer read locks are taken before the
    /// event read and released after the watermark, so a commit can never
    /// interleave between a captured buffer and its log view.
    pub async fn take_buffers_for_capture(
        &self,
        state: &AppState,
        org: Uuid,
        chat_id: Uuid,
    ) -> Result<CaptureView, ApiError> {
        let _capture = self.capture_lock.lock().await;
        let store = state.store().await?;
        let buffers = self.buffers(chat_id);
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
        let generating = self.is_generating(chat_id);
        let seq = store.thread().watermark().await?;
        Ok(CaptureView {
            text,
            thinking,
            generating,
            events,
            seq,
        })
    }
}

#[cfg(test)]
mod generation_table_tests {
    use super::*;
    use crate::config::Config;

    fn state() -> AppState {
        AppState::from_config(Config::test_config())
    }

    fn tool(_call: &str, machine: Option<&str>, connection: Option<Uuid>) -> PendingTool {
        PendingTool {
            name: "execute".into(),
            arguments: "{}".into(),
            machine_id: machine.map(str::to_string),
            workdir: None,
            connection_id: connection,
            done: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// The reservation is atomic: concurrent sends cannot both begin a
    /// generation for the chat, and a rejected send leaves nothing behind.
    #[test]
    fn try_begin_is_atomic_under_concurrency() {
        let s = state();
        let chat = Uuid::now_v7();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let s = s.clone();
                std::thread::spawn(move || s.generations.try_begin(chat))
            })
            .collect();
        let oks = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap().ok())
            .count();
        assert_eq!(oks, 1, "exactly one concurrent send reserves the chat");
        let err = s.generations.try_begin(chat).unwrap_err();
        assert_eq!(err.code, "generation_in_progress");
        // The slot frees cleanly.
        assert!(s.generations.remove(chat));
        assert!(s.generations.try_begin(chat).is_ok());
    }

    #[test]
    fn attach_reuses_the_running_generation() {
        let s = state();
        let chat = Uuid::now_v7();
        let first = s.generations.attach(chat);
        let second = s.generations.attach(chat);
        assert_eq!(first.id, second.id);
        assert!(Arc::ptr_eq(&first.text, &second.text));
        assert!(Arc::ptr_eq(&first.cancel, &second.cancel));
    }

    #[test]
    fn cancel_flag_follows_the_generation_lifecycle() {
        let s = state();
        let chat = Uuid::now_v7();
        assert!(s.generations.cancel_flag(chat).is_none());
        let handle = s.generations.attach(chat);
        let flag = s.generations.cancel_flag(chat).unwrap();
        assert!(Arc::ptr_eq(&handle.cancel, &flag));
        assert!(!flag.load(std::sync::atomic::Ordering::SeqCst));
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        s.generations.remove(chat);
        assert!(s.generations.cancel_flag(chat).is_none());
    }

    /// Pending tools live and die with their generation; clearing fires the
    /// watcher's done signal (a permit is stored even when the watcher is
    /// between iterations).
    #[tokio::test]
    async fn pending_tools_live_and_die_with_the_generation() {
        let s = state();
        let chat = Uuid::now_v7();
        let call = Uuid::now_v7().to_string();
        // No generation: the call is not tracked (watchers see it resolved).
        s.generations
            .set_pending_tool(chat, &call, tool(&call, Some("m"), None));
        assert!(!s.generations.has_pending_tool(chat, &call));

        s.generations.attach(chat);
        let done = s
            .generations
            .set_pending_tool(chat, &call, tool(&call, Some("m"), None));
        assert!(s.generations.has_pending_tool(chat, &call));
        // owns_pending_tool matches the dispatch connection only.
        assert!(!s.generations.owns_pending_tool(chat, &call, Uuid::now_v7()));
        let conn = Uuid::now_v7();
        s.generations.set_pending_tool_connection(chat, &call, Some(conn));
        assert!(s.generations.owns_pending_tool(chat, &call, conn));
        assert!(!s.generations.owns_pending_tool(chat, &call, Uuid::now_v7()));

        let waiter_done = done.clone();
        let notified = tokio::spawn(async move {
            waiter_done.notified().await;
        });
        // Yield once so the waiter parks on the notify.
        tokio::task::yield_now().await;
        assert!(s.generations.clear_pending_tool(chat, &call));
        tokio::time::timeout(std::time::Duration::from_secs(1), notified)
            .await
            .expect("done signal fires")
            .unwrap();
        assert!(!s.generations.has_pending_tool(chat, &call));
        assert!(!s.generations.clear_pending_tool(chat, &call));

        // Removing the generation drops any leftover suspended calls.
        s.generations
            .set_pending_tool(chat, "leftover", tool("leftover", Some("m"), None));
        s.generations.remove(chat);
        assert!(!s.generations.has_pending_tool(chat, "leftover"));
    }

    #[test]
    fn stale_machine_calls_report_connection_mismatches() {
        let s = state();
        let chat_a = Uuid::now_v7();
        let chat_b = Uuid::now_v7();
        s.generations.attach(chat_a);
        s.generations.attach(chat_b);
        let live_conn = Uuid::now_v7();
        s.generations
            .set_pending_tool(chat_a, "a1", tool("a1", Some("m"), Some(Uuid::now_v7())));
        s.generations
            .set_pending_tool(chat_b, "b1", tool("b1", Some("m"), Some(live_conn)));
        // A tool bound to a different machine is never reported.
        s.generations
            .set_pending_tool(chat_b, "b2", tool("b2", Some("other"), Some(Uuid::now_v7())));
        let stale = s.generations.stale_machine_calls("m", live_conn);
        assert_eq!(stale, vec![(chat_a, "a1".to_string())]);
    }

    #[test]
    fn active_streams_lists_tracked_chats_generations() {
        let s = state();
        let chat_a = Uuid::now_v7();
        let chat_b = Uuid::now_v7();
        let chat_c = Uuid::now_v7();
        let ha = s.generations.attach(chat_a);
        s.generations.attach(chat_c);
        let active = s.generations.active_streams(&[chat_a, chat_b, chat_c]);
        assert_eq!(active.len(), 2);
        assert!(active.iter().any(|(c, id, _)| *c == chat_a && *id == ha.id));
        assert!(active.iter().any(|(c, _, _)| *c == chat_c));
    }

    #[tokio::test]
    async fn buffers_snapshot_the_running_generation() {
        let s = state();
        let chat = Uuid::now_v7();
        assert!(s.generations.buffers(chat).is_none());
        let handle = s.generations.attach(chat);
        *handle.text.write().await = "partial answer".into();
        let (text, thinking) = s.generations.buffers(chat).unwrap();
        assert_eq!(*text.read().await, "partial answer");
        assert!(thinking.read().await.is_empty());
    }

    /// Capture during commit never tears (the feed's thread-sync contract):
    /// a step's text is visible either in the unpersisted buffer or in the
    /// event log, never in both — the buffer read locks are held across the
    /// event read and the watermark, so the worker's commit cannot interleave.
    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn capture_during_commit_never_shows_a_step_twice() {
        use crate::http::gateway::persist_assistant_step;
        use crate::test_support::full_state;
        use protocol::api::{Block, ThreadEvent};

        let fs = full_state().await;
        let state = fs.state.clone();
        let (org, chat) = (fs.org_id, fs.chat_id);
        state.generations.attach(chat);

        let writer_state = state.clone();
        let writer = tokio::spawn(async move {
            for i in 0..40u32 {
                *writer_state.generations.attach(chat).text.write().await =
                    format!("step-{i}");
                let event = ThreadEvent::AssistantMessage {
                    turn: 1,
                    step: i,
                    blocks: vec![Block::Text {
                        text: format!("step-{i}"),
                    }],
                    usage: protocol::api::UsagePayload::default(),
                    model: "deepseek-test".into(),
                    interrupted: None,
                };
                persist_assistant_step(&writer_state, chat, &event)
                    .await
                    .expect("step commits");
            }
        });

        let mut readers = Vec::new();
        for _ in 0..3 {
            let state = state.clone();
            readers.push(tokio::spawn(async move {
                for _ in 0..25 {
                    let view = state
                        .generations
                        .take_buffers_for_capture(&state, org, chat)
                        .await
                        .expect("capture");
                    let committed: Vec<String> = view
                        .events
                        .iter()
                        .filter_map(|row| match &row.event {
                            ThreadEvent::AssistantMessage { blocks, .. } => {
                                blocks.iter().find_map(|b| match b {
                                    Block::Text { text } => Some(text.clone()),
                                    _ => None,
                                })
                            }
                            _ => None,
                        })
                        .collect();
                    // The one torn shape: buffer still holds the step while
                    // the log already carries it.
                    if !view.text.is_empty() {
                        assert!(
                            !committed.contains(&view.text),
                            "torn capture: '{}' in both buffer and log",
                            view.text
                        );
                    }
                    // seq is allocated after the event read, so it never
                    // trails a captured event.
                    for row in &view.events {
                        assert!(view.seq >= row.seq);
                    }
                }
            }));
        }
        writer.await.unwrap();
        for r in readers {
            r.await.unwrap();
        }
    }
}
