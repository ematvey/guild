//! Server-side routine execution: durable loop driven by the Restate
//! handler; every nondeterministic step is journaled by the caller (spec
//! §4.6). This module is plain async so it's testable without Restate.

use anyhow::Context as _;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use guild_core::tools::{Tool, ToolFailure, ToolOutcome, ToolRegistry};
use protocol::api::{Message, StreamEvent, ToolCall, ToolSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct RoutineConfig {
    pub id: Uuid,
    pub org_id: Uuid,
    #[serde(default)]
    pub created_by: Option<Uuid>,
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub allowed_tools: Value,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Completion {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub cost_usd: f64,
    pub tokens_in: u32,
    pub tokens_out: u32,
}

#[derive(Clone)]
pub struct RoutineExecutor {
    pub api_base: String,
    pub internal_token: String,
    pub allow_http_tool: bool,
}

impl RoutineExecutor {
    fn http(&self) -> reqwest::Client {
        reqwest::Client::new()
    }

    fn internal_get(&self, url: impl Into<String>) -> reqwest::RequestBuilder {
        self.http()
            .get(url.into())
            .bearer_auth(&self.internal_token)
    }

    fn internal_post(&self, url: impl Into<String>) -> reqwest::RequestBuilder {
        self.http()
            .post(url.into())
            .bearer_auth(&self.internal_token)
    }

    pub async fn load_config(&self, routine_id: Uuid) -> anyhow::Result<RoutineConfig> {
        let url = format!(
            "{}/api/v1/internal/routines/{routine_id}",
            self.api_base.trim_end_matches('/')
        );
        let resp = self.internal_get(url).send().await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "load routine failed: {}",
            resp.status()
        );
        Ok(resp.json().await?)
    }

    pub async fn start_run(&self, routine_id: Uuid, trigger: &str) -> anyhow::Result<Uuid> {
        let url = format!(
            "{}/api/v1/internal/runs",
            self.api_base.trim_end_matches('/')
        );
        let resp = self
            .internal_post(url)
            .json(&json!({"routine_id": routine_id, "trigger": trigger}))
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "start run failed: {}",
            resp.status()
        );
        let v: Value = resp.json().await?;
        Ok(v["run_id"].as_str().context("no run_id")?.parse()?)
    }

    pub async fn finish_run(
        &self,
        run_id: Uuid,
        status: &str,
        summary: Option<&str>,
        error: Option<&str>,
    ) -> anyhow::Result<()> {
        // finish_run is a store update keyed by run id; reuse start_run's
        // internal endpoint with a `finished` payload.
        let url = format!(
            "{}/api/v1/internal/runs/finish",
            self.api_base.trim_end_matches('/')
        );
        let resp = self
            .internal_post(url)
            .json(&json!({"run_id": run_id, "status": status, "summary": summary, "error": error}))
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "finish run failed: {}",
            resp.status()
        );
        Ok(())
    }

    /// One model call through the internal completion endpoint (journaled by
    /// the caller). Tool calls arrive assembled.
    pub async fn completion(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        model: &str,
        system: Option<String>,
        messages: Vec<Message>,
        tools: Vec<ToolSpec>,
    ) -> anyhow::Result<Completion> {
        let url = format!(
            "{}/api/v1/internal/completion",
            self.api_base.trim_end_matches('/')
        );
        let body = json!({
            "org_id": org_id,
            "user_id": user_id,
            "model": model,
            "system": system,
            "messages": messages,
            "tools": tools,
        });
        let resp = self
            .internal_post(url)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "completion failed: {}",
            resp.status()
        );

        let mut text = String::new();
        let mut tool_calls = Vec::new();
        let mut cost = 0.0f64;
        let mut tokens_in = 0u32;
        let mut tokens_out = 0u32;
        let mut stream = resp.bytes_stream().eventsource();
        while let Some(ev) = stream.next().await {
            let ev = ev?;
            let parsed: StreamEvent = serde_json::from_str(&ev.data)?;
            match parsed {
                StreamEvent::Delta { content } => text.push_str(&content),
                StreamEvent::ToolCallDone { call } => tool_calls.push(call),
                // Tool lifecycle events target interactive clients; the
                // routine executor consumes only the model-facing content.
                // Idle only ever appears on the attach endpoint, never here.
                StreamEvent::Idle => {}
                StreamEvent::ToolStarted { .. } => {}
                StreamEvent::ToolCompleted { .. } => {}
                StreamEvent::Done {
                    cost_usd,
                    tokens_in: ti,
                    tokens_out: to,
                    ..
                } => {
                    cost = cost_usd;
                    tokens_in = ti;
                    tokens_out = to;
                }
                StreamEvent::ToolCallDelta { .. } => {}
                StreamEvent::Error { code, message } => {
                    anyhow::bail!("completion stream error [{code}]: {message}");
                }
            }
        }
        Ok(Completion {
            text,
            tool_calls,
            cost_usd: cost,
            tokens_in,
            tokens_out,
        })
    }

    /// External HTTP call (an allowed routine action).
    pub async fn http_call(
        &self,
        url: &str,
        method: &str,
        body: Option<String>,
    ) -> anyhow::Result<(u16, String)> {
        let parsed: reqwest::Url = url.parse().context("bad url")?;
        if !self.allow_http_tool && parsed.scheme() != "https" {
            anyhow::bail!("only https URLs allowed in routines");
        }
        let method = reqwest::Method::from_bytes(method.as_bytes()).context("bad method")?;
        let mut req = self.http().request(method, parsed);
        if let Some(b) = body {
            req = req.body(b);
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, text))
    }

    /// Object storage write (an allowed routine action).
    pub async fn storage_put(
        &self,
        org_id: Uuid,
        key: &str,
        content: Vec<u8>,
    ) -> anyhow::Result<()> {
        let url = format!(
            "{}/api/v1/internal/storage?org_id={org_id}&key={}",
            self.api_base.trim_end_matches('/'),
            urlencode(key),
        );
        let resp = self
            .internal_post(url)
            .header("content-type", "application/octet-stream")
            .body(content)
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "storage put failed: {}",
            resp.status()
        );
        Ok(())
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// ---------- worker tools (guild-core Tool impls over the executor) ----------

pub struct HttpCallTool {
    exec: RoutineExecutor,
}

#[async_trait::async_trait]
impl Tool for HttpCallTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "http_call".into(),
            description: "Perform an external HTTP(S) GET/POST/PUT/DELETE request.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE"]},
                    "body": {"type": "string"},
                },
                "required": ["url", "method"],
            }),
        }
    }

    fn default_policy(&self) -> guild_core::tools::Approval {
        guild_core::tools::Approval::Allow // server-side routines are pre-approved by their creator
    }

    async fn run(
        &self,
        _workdir: &std::path::Path,
        args: Value,
    ) -> Result<ToolOutcome, ToolFailure> {
        let url = args["url"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing url".into()))?;
        let method = args["method"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing method".into()))?;
        let body = args["body"].as_str().map(String::from);
        let (status, body) = self
            .exec
            .http_call(url, method, body)
            .await
            .map_err(|e| ToolFailure::Execution(e.to_string()))?;
        Ok(ToolOutcome {
            output_for_model: format!("status {status}: {}", truncate(&body)),
            ui_summary: Some(format!("{method} {url} → {status}")),
            diff: None,
        })
    }
}

pub struct StoragePutTool {
    exec: RoutineExecutor,
    org_id: Uuid,
}

#[async_trait::async_trait]
impl Tool for StoragePutTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "storage_put".into(),
            description: "Store text content in the org's object storage under runs/<key>.".into(),
            parameters: json!({
                "type": "object",
                "properties": {"key": {"type": "string"}, "content": {"type": "string"}},
                "required": ["key", "content"],
            }),
        }
    }

    fn default_policy(&self) -> guild_core::tools::Approval {
        guild_core::tools::Approval::Allow
    }

    async fn run(
        &self,
        _workdir: &std::path::Path,
        args: Value,
    ) -> Result<ToolOutcome, ToolFailure> {
        let key = args["key"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing key".into()))?;
        let content = args["content"]
            .as_str()
            .ok_or_else(|| ToolFailure::InvalidInput("missing content".into()))?;
        self.exec
            .storage_put(self.org_id, key, content.as_bytes().to_vec())
            .await
            .map_err(|e| ToolFailure::Execution(e.to_string()))?;
        Ok(ToolOutcome {
            output_for_model: format!("stored under runs/{key}"),
            ui_summary: Some(format!("stored {key}")),
            diff: None,
        })
    }
}

fn truncate(s: &str) -> String {
    if s.len() > 8 * 1024 {
        format!("{}[truncated]", &s[..8 * 1024])
    } else {
        s.to_string()
    }
}

pub fn tool_registry(exec: &RoutineExecutor, org_id: Uuid, allowed: &[String]) -> ToolRegistry {
    let mut reg = ToolRegistry::new();
    for name in allowed {
        match name.as_str() {
            "http_call" => reg.add(Arc::new(HttpCallTool { exec: exec.clone() })),
            "storage_put" => reg.add(Arc::new(StoragePutTool {
                exec: exec.clone(),
                org_id,
            })),
            _ => {} // unknown tool names ignored
        }
    }
    reg
}
