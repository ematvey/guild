//! Cloud API client — the only path from a Guild client to model providers
//! (spec §4.2: gateway is internal to Guild clients).

use futures::SinkExt;
use futures::Stream;
use protocol::api::{
    Chat, ChatCompletionRequest, CreateChatRequest, CreateProjectRequest, LoginRequest,
    LoginResponse, Message, PairRequest, PairResponse, Project, StreamEvent, ThreadEvent,
    ToolCall, UserInfo,
};
use protocol::ws::WsServerMsg;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMessage;

#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    #[error("invalid credentials or unauthorized")]
    Unauthorized,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("cloud request failed: {0}")]
    Request(String),
}

impl From<reqwest::Error> for CloudError {
    fn from(e: reqwest::Error) -> Self {
        CloudError::Request(e.to_string())
    }
}

#[derive(Clone)]
pub struct CloudClient {
    pub base_url: String,
    pub token: String,
}

impl CloudClient {
    pub async fn login(
        base_url: &str,
        email: &str,
        password: &str,
    ) -> Result<(String, UserInfo), CloudError> {
        let url = format!("{}/api/v1/auth/login", base_url.trim_end_matches('/'));
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Request(e.to_string()))?
            .post(&url)
            .json(&LoginRequest {
                email: email.into(),
                password: password.into(),
            })
            .send()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CloudError::Unauthorized);
        }
        if !resp.status().is_success() {
            return Err(CloudError::Request(format!(
                "login failed: {}",
                resp.status()
            )));
        }
        let login: LoginResponse = resp
            .json()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        Ok((login.token, login.user))
    }

    /// Redeems a one-time pairing code (`g1|<server_url>|<secret>`) for a
    /// normal session. Returns (server_url, token, user).
    pub async fn pair(code: &str) -> Result<(String, String, UserInfo), CloudError> {
        let (base_url, _secret) = parse_pairing_code(code)?;
        let url = format!("{}/api/v1/auth/pair", base_url.trim_end_matches('/'));
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Request(e.to_string()))?
            .post(&url)
            .json(&PairRequest {
                code: code.to_string(),
            })
            .send()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CloudError::Unauthorized);
        }
        if !resp.status().is_success() {
            return Err(CloudError::Request(format!(
                "pairing failed: {}",
                resp.status()
            )));
        }
        let pair: PairResponse = resp
            .json()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        Ok((base_url, pair.token, pair.user))
    }

    pub async fn refresh_session(&self) -> Result<(), CloudError> {
        let response = Self::timed(self.http().post(format!(
            "{}/api/v1/auth/refresh",
            self.base_url.trim_end_matches('/')
        )))
        .bearer_auth(&self.token)
        .send()
        .await?;
        Self::check(response).await?;
        Ok(())
    }

    /// Validates the stored token and returns the user (GET /api/v1/auth/me).
    pub async fn me(&self) -> Result<UserInfo, CloudError> {
        let url = format!("{}/api/v1/auth/me", self.base_url.trim_end_matches('/'));
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Request(e.to_string()))?
            .get(&url)
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CloudError::Unauthorized);
        }
        if !resp.status().is_success() {
            return Err(CloudError::Request(format!("me failed: {}", resp.status())));
        }
        let me: UserInfo = resp
            .json()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        Ok(me)
    }

    /// Enabled models routed for the org (GET /api/v1/gateway/models).
    pub async fn list_models(&self) -> Result<Vec<String>, CloudError> {
        let url = format!(
            "{}/api/v1/gateway/models",
            self.base_url.trim_end_matches('/')
        );
        let resp = Self::timed(self.http().get(&url))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let resp = Self::check(resp).await?;
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        Ok(v["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn create_chat(&self, title: Option<&str>) -> Result<Uuid, CloudError> {
        let url = format!("{}/api/v1/chats", self.base_url.trim_end_matches('/'));
        let resp = Self::timed(self.http().post(&url))
            .bearer_auth(&self.token)
            .json(&CreateChatRequest {
                title: title.map(Into::into),
                machine_id: None,
                project_id: None,
            })
            .send()
            .await?;
        let resp = Self::check(resp).await?;
        let chat: Chat = resp
            .json()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        Ok(chat.id)
    }

    /// Projects of the caller's org (workspace folders + machine bindings).
    pub async fn list_projects(&self) -> Result<Vec<Project>, CloudError> {
        let url = format!("{}/api/v1/projects", self.base_url.trim_end_matches('/'));
        let resp = Self::check(Self::timed(self.http().get(&url))
            .bearer_auth(&self.token)
            .send()
            .await?)
        .await?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        serde_json::from_value(body["projects"].clone())
            .map_err(|e| CloudError::Request(format!("bad projects body: {e}")))
    }

    /// Creates a project (a named workspace folder bound to a machine).
    pub async fn create_project(
        &self,
        req: &CreateProjectRequest,
    ) -> Result<Project, CloudError> {
        let url = format!("{}/api/v1/projects", self.base_url.trim_end_matches('/'));
        let resp = Self::check(Self::timed(self.http().post(&url))
            .bearer_auth(&self.token)
            .json(req)
            .send()
            .await?)
        .await?;
        resp.json::<Project>()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))
    }

    /// Records an approval decision for a client-tool call the durable
    /// workflow is waiting on (the engine protocol's agent.approve surface).
    pub async fn resolve_approval(
        &self,
        chat_id: Uuid,
        call_id: &str,
        approved: bool,
        reason: Option<&str>,
    ) -> Result<(), CloudError> {
        let url = format!(
            "{}/api/v1/gateway/chat/{chat_id}/approvals/{}",
            self.base_url.trim_end_matches('/'),
            call_id
        );
        let mut body = serde_json::json!({ "approved": approved });
        if let Some(reason) = reason {
            body["reason"] = serde_json::json!(reason);
        }
        Self::check(Self::timed(self.http().post(&url))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await?)
        .await?;
        Ok(())
    }

    /// Streams `StreamEvent` frames for one completion. The server persists
    /// history; the client sends only the new user message.
    pub async fn chat_stream(
        &self,
        chat_id: Uuid,
        model: &str,
        messages: &[Message],
    ) -> Result<impl Stream<Item = Result<StreamEvent, CloudError>> + 'static, CloudError> {
        self.stream_completion(ChatCompletionRequest {
            send_mode: None,
            user_message_id: None,
            chat_id,
            model: model.into(),
            messages: messages.to_vec(),
            tools: None,
            system: None,
            // plain chat answers no client tools: declaring them would
            // suspend the turn until the server-side tool timeout
            client_tools: false,
            attachment_ids: Vec::new(),
            project_id: None,
            skills_index: None,
            agents_md: None,
        })
        .await
    }

    /// Generic streaming completion; agent sessions pass tools + system.
    pub async fn stream_completion(
        &self,
        req: ChatCompletionRequest,
    ) -> Result<impl Stream<Item = Result<StreamEvent, CloudError>> + 'static, CloudError> {
        self.refresh_session().await?;
        // Subscribe before submitting the command. The command waits until
        // the feed has attached to the generation before invoking the worker.
        let ticket = Self::check(
            Self::timed(self.http().post(format!(
                "{}/api/v1/ws/ticket",
                self.base_url.trim_end_matches('/')
            )))
            .bearer_auth(&self.token)
            .send()
            .await?,
        )
        .await?
        .json::<serde_json::Value>()
        .await?;
        let mut url = url::Url::parse(&format!(
            "{}/api/v1/ws",
            self.base_url.trim_end_matches('/')
        ))
        .map_err(|e| CloudError::Request(e.to_string()))?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| CloudError::Request("invalid server URL".into()))?;
        url.query_pairs_mut()
            .append_pair(
                "ticket",
                ticket["ticket"]
                    .as_str()
                    .ok_or_else(|| CloudError::Request("missing ticket".into()))?,
            )
            .append_pair("client_id", &Uuid::now_v7().to_string());
        let (mut socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await
        .map_err(|_| CloudError::Request("socket connect timeout".into()))?
        .map_err(|e| CloudError::Request(e.to_string()))?;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                match next_socket_message(&mut socket).await? {
                    WsServerMsg::ThreadList { .. } => return Ok(()),
                    WsServerMsg::AuthRequired => return Err(CloudError::Unauthorized),
                    WsServerMsg::Error { message } => return Err(CloudError::Request(message)),
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| CloudError::Request("socket bootstrap deadline".into()))??;
        let chat_id = req.chat_id;
        let command = Self::timed(self.http().post(format!(
            "{}/api/v1/gateway/chat",
            self.base_url.trim_end_matches('/')
        )))
        .bearer_auth(&self.token)
        .json(&req)
        .send();
        tokio::pin!(command);
        let mut buffered = std::collections::VecDeque::new();
        let generation_id = loop {
            tokio::select! {
                response = &mut command => {
                    let ack: serde_json::Value = Self::check(response?).await?.json().await?;
                    break ack["generation_id"].as_str().and_then(|id| id.parse::<Uuid>().ok())
                        .ok_or_else(|| CloudError::Request("missing generation identity".into()))?;
                }
                message = next_socket_message(&mut socket) => {
                    let message = message?;
                    if matches!(message, WsServerMsg::AuthRequired) { return Err(CloudError::Unauthorized); }
                    if matches!(message, WsServerMsg::LiveFrame { chat_id: id, .. } if id == chat_id) {
                        if buffered.len() >= 4096 { return Err(CloudError::Request("socket output overflow".into())); }
                        buffered.push_back(message);
                    }
                }
            }
        };
        let cloud = self.clone();
        Ok(async_stream::stream! {
            loop {
                let incoming = match buffered.pop_front() {
                    Some(message) => Ok(message),
                    None => next_socket_message(&mut socket).await,
                };
                match incoming {
                    Ok(WsServerMsg::LiveFrame { chat_id: id, generation_id: generation, event, .. }) if id == chat_id && generation == generation_id => {
                        let done = matches!(event, StreamEvent::Done { .. } | StreamEvent::Error { .. });
                        yield Ok(event);
                        if done { break; }
                    }
                    Ok(WsServerMsg::AuthRequired) => {
                        let _ = cloud.refresh_session().await;
                        yield Err(CloudError::Unauthorized);
                        break;
                    }
                    Ok(WsServerMsg::Error { message }) => {
                        yield Err(CloudError::Request(message)); break;
                    }
                    Ok(_) => {},
                    Err(error) => { yield Err(error); break; }
                }
            }
        })
    }

    /// Persists a client-produced tool result to the server's thread event
    /// log (engine sessions execute tools locally; `turn: 0` makes the server
    /// join the result to the latest turn).
    pub async fn append_tool_message(
        &self,
        chat_id: Uuid,
        call: &ToolCall,
        content: &str,
        is_error: bool,
        meta: Option<serde_json::Value>,
    ) -> Result<(), CloudError> {
        let event = ThreadEvent::ToolResult {
            turn: 0,
            step: 0,
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: content.to_string(),
            is_error,
            meta,
            images: Vec::new(),
            kind: None,
            artifact_id: None,
        };
        let url = format!(
            "{}/api/v1/chats/{chat_id}/thread",
            self.base_url.trim_end_matches('/')
        );
        let resp = Self::timed(self.http().post(&url))
            .bearer_auth(&self.token)
            .json(&event)
            .send()
            .await?;
        Self::check(resp).await?;
        Ok(())
    }

    /// Downloads one spilled tool-result artifact's bytes
    /// (GET /api/v1/tool_artifacts/{id} — the artifact download endpoint,
    /// symmetric to attachments). Member-auth, org-scoped server-side.
    pub async fn fetch_tool_artifact(&self, artifact_id: Uuid) -> Result<Vec<u8>, CloudError> {
        let url = format!(
            "{}/api/v1/tool_artifacts/{artifact_id}",
            self.base_url.trim_end_matches('/')
        );
        let resp = Self::timed(self.http().get(&url))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let resp = Self::check(resp).await?;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        Ok(bytes.to_vec())
    }

    /// The chat's thread event log (GET /api/v1/chats/{id}/thread): the
    /// source the artifact path→id index rebuilds from. Unparseable rows
    /// are skipped, never fatal.
    pub async fn thread_events(&self, chat_id: Uuid) -> Result<Vec<ThreadEvent>, CloudError> {
        let url = format!(
            "{}/api/v1/chats/{chat_id}/thread",
            self.base_url.trim_end_matches('/')
        );
        let resp = Self::timed(self.http().get(&url))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let resp = Self::check(resp).await?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Request(e.to_string()))?;
        let mut events = Vec::new();
        for row in body["events"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            if let Ok(ev) = serde_json::from_value::<ThreadEvent>(row["event"].clone()) {
                events.push(ev);
            }
        }
        Ok(events)
    }

    /// Public for the registry client (same base/token).
    pub fn http_pub(&self) -> reqwest::Client {
        self.http()
    }

    /// Mints a single-use WS connect ticket (30 s TTL, in-memory). The
    /// machine link mints one per (re)connect — long-lived tokens never
    /// appear in the upgrade query string.
    pub async fn ws_ticket(&self) -> Result<String, CloudError> {
        let resp = Self::check(
            Self::timed(
                self.http()
                    .post(format!("{}/api/v1/ws/ticket", self.base_url.trim_end_matches('/'))),
            )
            .bearer_auth(&self.token)
            .send()
            .await?,
        )
        .await?
        .json::<serde_json::Value>()
        .await?;
        Ok(resp["ticket"]
            .as_str()
            .map(str::to_string)
            .ok_or(CloudError::Request("ticket response missing ticket".into()))?)
    }

    /// Shared client: connect-level timeout only. No total timeout —
    /// streaming endpoints rely on the connect bound and server keepalive;
    /// a client-level cap killed long turns at 10 minutes.
    fn http(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client builds")
    }

    /// Request-level cap for plain JSON calls (login, me, thread appends).
    fn timed(rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        rb.timeout(Duration::from_secs(30))
    }

    /// Public for the registry client.
    pub async fn check(resp: reqwest::Response) -> Result<reqwest::Response, CloudError> {
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CloudError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(CloudError::NotFound("no such resource".into()));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(CloudError::Request(format!("status {status}: {body}")));
        }
        Ok(resp)
    }
}

async fn next_socket_message<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<WsServerMsg, CloudError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), socket.next())
            .await
            .map_err(|_| CloudError::Request("socket silence deadline".into()))?
            .ok_or_else(|| CloudError::Request("socket closed".into()))?
            .map_err(|e| CloudError::Request(e.to_string()))?;
        match frame {
            WsMessage::Text(text) => {
                if let Ok(message) = serde_json::from_str(&text) {
                    return Ok(message);
                }
            }
            WsMessage::Ping(payload) => {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    socket.send(WsMessage::Pong(payload)),
                )
                .await
                .map_err(|_| CloudError::Request("socket write timeout".into()))?
                .map_err(|e| CloudError::Request(e.to_string()))?;
            }
            WsMessage::Close(_) => return Err(CloudError::Request("socket closed".into())),
            _ => {}
        }
    }
}

use futures::StreamExt;
use uuid::Uuid;

/// Collects a full turn: returns (text, done-info) after consuming the stream.
pub async fn collect_turn<S>(stream: S) -> anyhow::Result<(String, Option<StreamEvent>)>
where
    S: Stream<Item = Result<StreamEvent, CloudError>>,
{
    let mut text = String::new();
    let mut done = None;
    let mut pinned = Box::pin(stream);
    while let Some(ev) = pinned.next().await {
        match ev? {
            StreamEvent::Delta { content } => text.push_str(&content),
            d @ StreamEvent::Done { .. } => done = Some(d),
            StreamEvent::Error { code, message } => {
                anyhow::bail!("stream error [{code}]: {message}");
            }
            // Plain-chat clients ignore tool-call frames; the agent loop
            // (Task 5/6) consumes them through its own streaming path.
            StreamEvent::ToolCallDelta { .. } | StreamEvent::ToolCallDone { .. } => {}
            // Tool lifecycle notifications are for interactive clients.
            StreamEvent::ToolStarted { .. } | StreamEvent::ToolCompleted { .. } => {}
            // attach-endpoint only; never on the completion stream
            StreamEvent::Idle => {}
            // Approval lifecycle frames are for interactive clients.
            StreamEvent::ApprovalRequested { .. } | StreamEvent::ApprovalResolved { .. } => {}
            // Reasoning is display-only for plain-chat clients here.
            StreamEvent::ThinkingDelta { .. } => {}
        }
    }
    Ok((text, done))
}

/// Splits a pairing code `g1|<server_url>|<secret>` into (server_url, secret).
/// The server URL is routing info, kept readable on purpose so the pairing
/// screen can show the user where they are about to connect.
fn parse_pairing_code(code: &str) -> Result<(String, String), CloudError> {
    let rest = code
        .strip_prefix("g1|")
        .ok_or_else(|| CloudError::Request("malformed pairing code".into()))?;
    let mut parts = rest.splitn(3, '|');
    let base_url = parts
        .next()
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .ok_or_else(|| CloudError::Request("pairing code: missing server url".into()))?;
    let secret = parts
        .next()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| CloudError::Request("pairing code: missing secret".into()))?;
    if parts.next().is_some() {
        return Err(CloudError::Request("malformed pairing code".into()));
    }
    Ok((base_url.to_string(), secret.to_string()))
}

#[cfg(test)]
mod pairing_tests {
    use super::parse_pairing_code;

    #[test]
    fn parses_valid_code() {
        let (url, secret) = parse_pairing_code("g1|https://guild.corp:18080|a1b2C3").unwrap();
        assert_eq!(url, "https://guild.corp:18080");
        assert_eq!(secret, "a1b2C3");
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "g1|ftp://x|a1",
            "g1|https://x|",
            "g1|https://x|zzz-not-hex",
            "g1|https://x|a1|extra",
            "x1|https://x|a1",
            "",
        ] {
            assert!(parse_pairing_code(bad).is_err(), "should reject: {bad}");
        }
    }
}

#[cfg(test)]
mod artifact_endpoints_tests {
    use super::*;
    use protocol::api::ThreadEvent;
    use serde_json::json;
    use uuid::Uuid;

    const CHAT: Uuid = uuid::uuid!("00000000-0000-0000-0000-000000000001");
    const ART: Uuid = uuid::uuid!("00000000-0000-0000-0000-00000000aaaa");

    #[tokio::test]
    async fn fetch_tool_artifact_downloads_bytes() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/api/v1/tool_artifacts/{ART}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(b"xlsx-bytes"))
            .mount(&server)
            .await;
        let cloud = CloudClient {
            base_url: server.uri(),
            token: "t".into(),
        };
        let bytes = cloud.fetch_tool_artifact(ART).await.unwrap();
        assert_eq!(bytes, b"xlsx-bytes");
    }

    #[tokio::test]
    async fn fetch_tool_artifact_maps_404_to_not_found() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let cloud = CloudClient {
            base_url: server.uri(),
            token: "t".into(),
        };
        assert!(matches!(
            cloud.fetch_tool_artifact(ART).await,
            Err(CloudError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn thread_events_parses_rows_and_skips_malformed() {
        let card = json!({ "card": {
            "card": "artifact", "id": ART, "filename": "report.xlsx",
            "content_type": "application/x", "size_bytes": 8,
            "path": format!(".guild/artifacts/{CHAT}/report.xlsx"),
        }});
        let body = json!({
            "events": [
                { "id": Uuid::now_v7(), "chat_id": CHAT, "seq": 1, "created_at": "2026-09-18T00:00:00Z",
                  "event": { "type": "tool_result", "turn": 1, "step": 1, "call_id": "c1",
                             "name": "api", "content": "ptr", "artifact_id": ART, "meta": card } },
                { "id": Uuid::now_v7(), "chat_id": CHAT, "seq": 2, "created_at": "2026-09-18T00:00:01Z",
                  "event": { "type": "user_message", "content": "hi" } },
                // malformed row: skipped, not fatal
                { "id": Uuid::now_v7(), "chat_id": CHAT, "seq": 3, "created_at": "2026-09-18T00:00:02Z",
                  "event": { "type": "tool_result" } },
            ],
            "context": { "tokens": 10, "max": 128000, "model": null },
        });
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!("/api/v1/chats/{CHAT}/thread")))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let cloud = CloudClient {
            base_url: server.uri(),
            token: "t".into(),
        };
        let events = cloud.thread_events(CHAT).await.unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            ThreadEvent::ToolResult { artifact_id: Some(id), .. } if *id == ART
        ));
        assert!(matches!(events[1], ThreadEvent::UserMessage { .. }));
    }
}
