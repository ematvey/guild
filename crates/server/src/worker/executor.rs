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
    /// Hosts http_call may reach even when they resolve into denied
    /// (loopback/link-local/private/metadata) ranges. From
    /// GUILD_HTTP_TOOL_ALLOW_HOSTS (comma-separated); empty denies all such
    /// targets.
    pub http_tool_allow_hosts: Vec<String>,
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
                StreamEvent::ThinkingDelta { .. } => {}
                StreamEvent::ApprovalRequested { .. } | StreamEvent::ApprovalResolved { .. } => {}
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
        if !matches!(parsed.scheme(), "http" | "https") {
            anyhow::bail!("only http(s) URLs allowed in routines");
        }
        if !self.allow_http_tool && parsed.scheme() != "https" {
            anyhow::bail!("only https URLs allowed in routines");
        }
        check_target(&parsed, &self.http_tool_allow_hosts).await?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).context("bad method")?;
        let mut req = self.http().request(method, parsed);
        if let Some(b) = body {
            req = req.body(b);
        }
        let mut resp = req.send().await?;
        let status = resp.status().as_u16();
        // Bounded read: a huge (or endless) response body must not balloon
        // the worker's memory. Anything past the cap is dropped.
        let mut body: Vec<u8> = Vec::new();
        let mut capped = false;
        while let Some(chunk) = resp.chunk().await? {
            if body.len() + chunk.len() > MAX_HTTP_RESPONSE_BYTES {
                let take = MAX_HTTP_RESPONSE_BYTES - body.len();
                body.extend_from_slice(&chunk[..take]);
                capped = true;
                break;
            }
            body.extend_from_slice(&chunk);
        }
        let mut text = String::from_utf8_lossy(&body).to_string();
        if capped {
            text.push_str("[response truncated at 1 MiB]");
        }
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

/// Memory cap on an http_call response body.
const MAX_HTTP_RESPONSE_BYTES: usize = 1024 * 1024;

/// SSRF guard for the routine http_call tool: the server container reaches
/// Restate ingress, Postgres/ClickHouse and cloud metadata endpoints, so a
/// target whose host is an IP in a denied range — loopback, link-local
/// (169.254/16, fe80::/10; the cloud metadata address is link-local),
/// private (RFC1918), unique-local (fc00::/7) or unspecified — or a hostname
/// resolving only into those ranges is refused, unless the host is
/// explicitly allow-listed in the executor config.
async fn check_target(url: &reqwest::Url, allow_hosts: &[String]) -> anyhow::Result<()> {
    let Some(host) = url.host_str() else {
        anyhow::bail!("http_call target has no host");
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or(80);
    if allow_hosts
        .iter()
        .any(|allowed| allowed.trim().to_ascii_lowercase() == host)
    {
        return Ok(());
    }
    // Literal IPs are checked directly; hostnames after resolving (a name
    // that resolves anywhere public passes, loopback-only names are denied).
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if ip_is_denied(&ip) {
            anyhow::bail!("http_call target '{host}' is in a denied range");
        }
        return Ok(());
    }
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .context("http_call target does not resolve")?
        .collect();
    anyhow::ensure!(!addrs.is_empty(), "http_call target does not resolve");
    if let Some(addr) = addrs.iter().find(|addr| ip_is_denied(&addr.ip())) {
        anyhow::bail!(
            "http_call target '{host}' resolves into a denied range ({})",
            addr.ip()
        );
    }
    Ok(())
}

/// The IP ranges a routine's http_call must never reach from the server.
fn ip_is_denied(ip: &std::net::IpAddr) -> bool {
    use std::net::IpAddr::*;
    match ip {
        V4(v4) => {
            v4.is_loopback()
                || v4.is_link_local()
                || v4.is_private()
                || v4.is_unspecified()
                || v4.is_broadcast()
                // RFC 6598 shared address space (100.64/10).
                || v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 0b0100_0000
        }
        V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unicast_link_local()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        }
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
            kind: Default::default(),
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
            artifact: None,
            images: Vec::new(),
            output_for_model: format!("status {status}: {}", truncate(&body)),
            ui_summary: Some(format!("{method} {url} → {status}")),
            diff: None,
            meta: None,
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
            kind: Default::default(),
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
            artifact: None,
            images: Vec::new(),
            output_for_model: format!("stored under runs/{key}"),
            ui_summary: Some(format!("stored {key}")),
            diff: None,
            meta: None,
        })
    }
}

fn truncate(s: &str) -> String {
    if s.len() > 8 * 1024 {
        let mut cut = 8 * 1024;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}[truncated]", &s[..cut])
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

#[cfg(test)]
mod tests {
    use super::truncate;

    #[test]
    fn truncate_never_splits_a_char() {
        // multi-byte char straddling the 8 KiB boundary must not panic
        let s = "é".repeat(4096 + 1); // 2 bytes each; boundary lands mid-char
        let t = truncate(&s);
        assert!(t.ends_with("[truncated]"));
        assert!(t.starts_with("é"));
    }

    #[test]
    fn truncate_leaves_short_output_alone() {
        assert_eq!(truncate("hello"), "hello");
    }
}

#[cfg(test)]
mod ssrf_tests {
    use super::{check_target, ip_is_denied, RoutineExecutor};
    use std::net::IpAddr;

    #[test]
    fn denied_ranges_cover_loopback_link_local_private_and_metadata() {
        for ip in [
            "127.0.0.1", "127.8.8.8", "169.254.169.254", "169.254.0.1", "10.0.0.1",
            "172.16.0.1", "192.168.1.1", "0.0.0.0", "100.64.0.1", "::1", "fe80::1",
            "fc00::1", "fd12:3456::1",
        ] {
            assert!(
                ip_is_denied(&ip.parse::<IpAddr>().unwrap()),
                "{ip} must be denied"
            );
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                !ip_is_denied(&ip.parse::<IpAddr>().unwrap()),
                "{ip} must be allowed"
            );
        }
    }

    #[tokio::test]
    async fn loopback_literal_is_refused_and_allow_list_rescues_it() {
        let exec = RoutineExecutor {
            api_base: "http://unused".into(),
            internal_token: "t".into(),
            allow_http_tool: true,
            http_tool_allow_hosts: Vec::new(),
        };
        assert!(exec.http_call("http://127.0.0.1:9/x", "GET", None)
            .await
            .is_err(), "loopback target refused by default");

        let allowed = RoutineExecutor {
            api_base: "http://unused".into(),
            internal_token: "t".into(),
            allow_http_tool: true,
            http_tool_allow_hosts: vec!["127.0.0.1".into()],
        };
        // The target passes the guard (the request itself fails to connect —
        // nothing listens on port 9 — which proves the guard is not the blocker).
        check_target(
            &"http://127.0.0.1:9/x".parse().unwrap(),
            &allowed.http_tool_allow_hosts,
        )
        .await
        .expect("allow-listed host passes the guard");
    }

    #[tokio::test]
    async fn localhost_hostname_resolving_to_loopback_is_refused() {
        let exec = RoutineExecutor {
            api_base: "http://unused".into(),
            internal_token: "t".into(),
            allow_http_tool: true,
            http_tool_allow_hosts: Vec::new(),
        };
        let err = exec
            .http_call("http://localhost:9/x", "GET", None)
            .await
            .expect_err("localhost resolves to loopback: denied");
        assert!(
            err.to_string().contains("denied range"),
            "refusal names the denied range: {err}"
        );
    }

    #[tokio::test]
    async fn non_http_scheme_is_refused_before_the_target_check() {
        let exec = RoutineExecutor {
            api_base: "http://unused".into(),
            internal_token: "t".into(),
            allow_http_tool: false,
            http_tool_allow_hosts: Vec::new(),
        };
        assert!(exec.http_call("ftp://example.com/x", "GET", None).await.is_err());
    }
}
