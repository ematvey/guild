//! Cloud API client — the only path from a Guild client to model providers
//! (spec §4.2: gateway is internal to Guild clients).

use eventsource_stream::Eventsource;
use futures::Stream;
use protocol::api::{
    Chat, ChatCompletionRequest, CreateChatRequest, LoginRequest, LoginResponse, Message,
    StreamEvent, UserInfo,
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

    pub async fn create_chat(&self, title: Option<&str>) -> Result<Uuid, CloudError> {
        let url = format!("{}/api/v1/chats", self.base_url.trim_end_matches('/'));
        let resp = self
            .http()
            .post(&url)
            .bearer_auth(&self.token)
            .json(&CreateChatRequest {
                title: title.map(Into::into),
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
                        Err(e) => Some(Err(CloudError::Request(format!("bad stream frame: {e}")))),
                    },
                    Err(e) => Some(Err(CloudError::Request(format!("stream error: {e}")))),
                }
            });
        Ok(stream)
    }

    /// Persists a client-produced tool message to the server record.
    pub async fn append_tool_message(&self, chat_id: Uuid, m: &Message) -> Result<(), CloudError> {
        let url = format!(
            "{}/api/v1/chats/{chat_id}/messages",
            self.base_url.trim_end_matches('/')
        );
        let resp = self
            .http()
            .post(&url)
            .bearer_auth(&self.token)
            .json(&serde_json::json!({
                "role": m.role,
                "content": m.content,
                "tool_call_id": m.tool_call_id,
            }))
            .send()
            .await?;
        Self::check(resp).await?;
        Ok(())
    }

    fn http(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()
            .expect("reqwest client builds")
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response, CloudError> {
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
        }
    }
    Ok((text, done))
}
