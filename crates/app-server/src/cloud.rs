//! Cloud API client — the only path from a Guild client to model providers
//! (spec §4.2: gateway is internal to Guild clients).

use eventsource_stream::Eventsource;
use futures::Stream;
use protocol::api::{
    Chat, ChatCompletionRequest, CreateChatRequest, LoginRequest, LoginResponse, Message,
    PairRequest, PairResponse, StreamEvent, ThreadEvent, ToolCall, UserInfo,
};
use std::time::Duration;

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

    /// Validates the stored token and returns the user (GET /api/v1/auth/me).
    pub async fn me(&self) -> Result<UserInfo, CloudError> {
        let url = format!(
            "{}/api/v1/auth/me",
            self.base_url.trim_end_matches('/')
        );
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
            return Err(CloudError::Request(format!(
                "me failed: {}",
                resp.status()
            )));
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

    /// Streams `StreamEvent` frames for one completion. The server persists
    /// history; the client sends only the new user message.
    pub async fn chat_stream(
        &self,
        chat_id: Uuid,
        model: &str,
        messages: &[Message],
    ) -> Result<impl Stream<Item = Result<StreamEvent, CloudError>> + 'static, CloudError> {
        self.stream_completion(ChatCompletionRequest {
            chat_id,
            model: model.into(),
            messages: messages.to_vec(),
            tools: None,
            system: None,
            // the desktop engine executes machine tools client-side
            client_tools: true,
                attachment_ids: Vec::new(),
            project_dir: None,
        })
        .await
    }

    /// Generic streaming completion; agent sessions pass tools + system.
    pub async fn stream_completion(
        &self,
        req: ChatCompletionRequest,
    ) -> Result<impl Stream<Item = Result<StreamEvent, CloudError>> + 'static, CloudError> {
        let url = format!(
            "{}/api/v1/gateway/chat",
            self.base_url.trim_end_matches('/')
        );
        let resp = self
            .http()
            .post(&url)
            .bearer_auth(&self.token)
            .json(&req)
            .send()
            .await?;
        let resp = Self::check(resp).await?;
        let stream = resp
            .bytes_stream()
            .eventsource()
            .filter_map(|ev| async move {
                match ev {
                    Ok(ev) => match serde_json::from_str::<StreamEvent>(&ev.data) {
                        Ok(parsed) => Some(Ok(parsed)),
                        // Unknown frame shapes (new server StreamEvent
                        // variants) are skipped, not fatal: a running client
                        // must survive a server adding frames. The `type`
                        // tag makes any *existing* variant's payload still
                        // parse-or-fail the same way.
                        Err(e) => {
                            if serde_json::from_str::<serde_json::Value>(&ev.data)
                                .map(|v| v.get("type").is_some())
                                .unwrap_or(false)
                            {
                                None
                            } else {
                                Some(Err(CloudError::Request(format!(
                                    "bad stream frame: {e}"
                                ))))
                            }
                        }
                    },
                    Err(e) => Some(Err(CloudError::Request(format!("stream error: {e}")))),
                }
            });
        Ok(stream)
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

    /// Public for the registry client (same base/token).
    pub fn http_pub(&self) -> reqwest::Client {
        self.http()
    }

    /// Shared client: connect-level timeout only. No total timeout — the
    /// SSE stream endpoints rely on the connect bound plus server keepalive;
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
