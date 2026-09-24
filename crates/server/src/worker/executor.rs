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
    #[serde(default)]
    pub trigger_config: Value,
}

/// Only the current schedule can run or reschedule. Numeric legacy timers
/// retire as soon as the first schedule update assigns a generation.
pub fn schedule_interval(config: &Value, scheduled: &Value) -> Option<u64> {
    let current = config.get("schedule_generation").filter(|v| !v.is_null());
    let supplied = scheduled.get("generation").filter(|v| !v.is_null());
    if current != supplied {
        return None;
    }
    let interval = config["interval_secs"]
        .as_u64()
        .or_else(|| scheduled.as_u64())?;
    (interval >= 5).then_some(interval)
}

/// Extracts the provider's own status from a provider error message
/// (the stable rendering "status NNN: body" the provider adapters emit).
fn provider_status(message: &str) -> Option<u16> {
    let idx = message.find("status ")?;
    let rest = &message[idx + "status ".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Why a routine's model step failed. Restate retries plain errors forever
/// unless the journaled run carries a bounded retry policy; every
/// non-retryable failure class must be typed terminal. Permanent provider
/// rejections are terminal; throttling/quota stay transient under the
/// model step's bounded retry policy.
#[derive(Debug, thiserror::Error)]
pub enum CompletionError {
    /// Non-retryable: any 4xx except 408 (a timed-out request can succeed on
    /// retry), including 429 — quota exhaustion stays exhausted and every
    /// retry would be a fresh paid request. An in-stream error event is
    /// terminal too: the provider already failed mid-answer.
    #[error("{0}")]
    Terminal(String),
    /// Transient: transport failures and 5xx — the invocation may retry.
    #[error(transparent)]
    Transient(#[from] anyhow::Error),
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

#[derive(Debug, thiserror::Error)]
#[error("routine {0} was deleted")]
pub struct RoutineMissing(pub Uuid);

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
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(RoutineMissing(routine_id).into());
        }
        anyhow::ensure!(
            resp.status().is_success(),
            "load routine failed: {}",
            resp.status()
        );
        Ok(resp.json().await?)
    }

    pub async fn start_run(
        &self,
        routine_id: Uuid,
        trigger: &str,
        invocation_id: &str,
    ) -> anyhow::Result<Uuid> {
        let url = format!(
            "{}/api/v1/internal/runs",
            self.api_base.trim_end_matches('/')
        );
        let resp = self
            .internal_post(url)
            .json(&json!({"routine_id": routine_id, "trigger": trigger, "invocation_id": invocation_id}))
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

    /// The internal completion endpoint translates provider failures into
    /// ApiError envelopes ({"error":{code,message}}); the classification
    /// must read the UNDERLYING provider condition, not the translated
    /// HTTP status: a provider 400 arrives as 502/provider_upstream, and
    /// both quota exhaustion and provider throttling arrive as
    /// 429-with-different-codes.
    fn classify_internal_failure(status: u16, body: &str) -> CompletionError {
        let parsed: Option<serde_json::Value> = serde_json::from_str(body.trim())
            .ok()
            .or_else(|| serde_json::from_str(&format!("{{\"error\":{}}}", body.trim())).ok());
        let code = parsed
            .as_ref()
            .and_then(|v| v["error"]["code"].as_str())
            .map(str::to_string);
        let message = parsed
            .as_ref()
            .and_then(|v| v["error"]["message"].as_str())
            .map(str::to_string);
        match (status, code.as_deref(), message.as_deref()) {
            // The provider itself rejected the request (translated to 502):
            // permanent rejection (4xx except 408/429) is terminal; provider
            // infrastructure (5xx) stays transient.
            (_, Some("provider_upstream"), Some(message)) => match provider_status(message) {
                Some(s) if (400..500).contains(&s) && s != 408 && s != 429 => {
                    CompletionError::Terminal(format!(
                        "completion failed: provider rejected the request: {message}"
                    ))
                }
                _ => CompletionError::Transient(anyhow::anyhow!("completion failed: {message}")),
            },
            // Quota exhaustion and provider throttling both arrive as 429.
            // Retrying them is legitimate (the throttle can lift, the month
            // rolls over) but must be BOUNDED — the journaled model-step run
            // carries a bounded retry policy, so these stay transient.
            (429, Some(code), _) if code == "provider_rate_limited" || code == "quota_exceeded" => {
                CompletionError::Transient(anyhow::anyhow!(
                    "completion failed: provider throttled or quota reached ({code})"
                ))
            }
            // Explicit unsupported-request rejections are permanent.
            (_, Some(_), Some(message)) if message.contains("not supported") => {
                CompletionError::Terminal(format!("completion failed: {message}"))
            }
            // Internal endpoint's own 4xx are deterministic.
            (s, _, _) if (400..500).contains(&s) && s != 408 => {
                CompletionError::Terminal(format!("completion failed: {status}"))
            }
            (s, _, _) => CompletionError::Transient(anyhow::anyhow!("completion failed: {s}")),
        }
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
    ) -> Result<Completion, CompletionError> {
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
            .await
            .map_err(|e| CompletionError::Transient(e.into()))?;
        let status = resp.status();
        if !status.is_success() {
            // Classify from the underlying provider condition the endpoint
            // translated (see classify_internal_failure), not the HTTP
            // status alone.
            let body = resp.text().await.unwrap_or_default();
            let truncated: String = body.chars().take(4096).collect();
            return Err(Self::classify_internal_failure(status.as_u16(), &truncated));
        }

        let mut text = String::new();
        let mut tool_calls = Vec::new();
        let mut cost = 0.0f64;
        let mut tokens_in = 0u32;
        let mut tokens_out = 0u32;
        let mut stream = resp.bytes_stream().eventsource();
        while let Some(ev) = stream.next().await {
            let ev = ev.map_err(|e| CompletionError::Transient(e.into()))?;
            let parsed: StreamEvent =
                serde_json::from_str(&ev.data).map_err(|e| CompletionError::Transient(e.into()))?;
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
                    // The provider failed mid-answer. Only a PERMANENT
                    // condition is terminal (a replay re-sends the same
                    // failing request); throttling and provider
                    // infrastructure can lift, so they stay transient under
                    // the bounded retry policy.
                    if (400..500).contains(&provider_status(&message).unwrap_or(0))
                        && !matches!(provider_status(&message), Some(408) | Some(429))
                    {
                        return Err(CompletionError::Terminal(format!(
                            "completion stream error [{code}]: {message}"
                        )));
                    }
                    return Err(CompletionError::Transient(anyhow::anyhow!(
                        "completion stream error [{code}]: {message}"
                    )));
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
        let addresses = check_target(&parsed, &self.http_tool_allow_hosts).await?;
        let host = parsed.host_str().context("missing host")?;
        // Pin the exact checked addresses: a second resolver lookup (or an
        // environment proxy) must not change the network destination.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .resolve_to_addrs(host, &addresses)
            .build()?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).context("bad method")?;
        let mut req = client.request(method, parsed);
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
/// resolving into any of those ranges is refused, unless the host is
/// explicitly allow-listed in the executor config.
async fn check_target(
    url: &reqwest::Url,
    allow_hosts: &[String],
) -> anyhow::Result<Vec<std::net::SocketAddr>> {
    let host = url
        .host_str()
        .context("http_call target has no host")?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or(80);
    let allow_private = allow_hosts
        .iter()
        .any(|allowed| allowed.trim().to_ascii_lowercase() == host);
    let addresses: Vec<std::net::SocketAddr> = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => vec![std::net::SocketAddr::new(ip, port)],
        Err(_) => tokio::net::lookup_host((host.as_str(), port))
            .await
            .context("http_call target does not resolve")?
            .collect(),
    };
    anyhow::ensure!(!addresses.is_empty(), "http_call target does not resolve");
    if !allow_private && addresses.iter().any(|address| ip_is_denied(&address.ip())) {
        anyhow::bail!("http_call target '{host}' resolves into a denied range");
    }
    Ok(addresses)
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
            v6.to_ipv4_mapped().is_some_and(|v4| ip_is_denied(&V4(v4)))
                || v6.is_loopback()
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
            "127.0.0.1",
            "127.8.8.8",
            "169.254.169.254",
            "169.254.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
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
        assert!(
            exec.http_call("http://127.0.0.1:9/x", "GET", None)
                .await
                .is_err(),
            "loopback target refused by default"
        );

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
        assert!(exec
            .http_call("ftp://example.com/x", "GET", None)
            .await
            .is_err());
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    #[test]
    fn stale_schedules_retire_and_current_schedules_use_current_interval() {
        let config = json!({"schedule_generation":"new", "interval_secs":45});
        assert_eq!(
            schedule_interval(&config, &json!({"generation":"new"})),
            Some(45)
        );
        assert_eq!(
            schedule_interval(&config, &json!({"generation":"old"})),
            None
        );
        assert_eq!(schedule_interval(&config, &json!(10)), None);
        assert_eq!(
            schedule_interval(&json!({"interval_secs":5}), &json!(10)),
            Some(5)
        );
        assert_eq!(schedule_interval(&Value::Null, &json!(10)), Some(10)); // old journaled config
        assert_eq!(
            schedule_interval(&json!({"interval_secs":0}), &json!(10)),
            None
        );
    }

    #[tokio::test]
    async fn redirects_are_not_followed_and_mapped_loopback_is_denied() {
        let destination = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .expect(0)
            .mount(&destination)
            .await;
        let source = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(
                wiremock::ResponseTemplate::new(302).insert_header("location", destination.uri()),
            )
            .mount(&source)
            .await;
        let exec = RoutineExecutor {
            api_base: String::new(),
            internal_token: String::new(),
            allow_http_tool: true,
            http_tool_allow_hosts: vec!["127.0.0.1".into()],
        };
        assert_eq!(
            exec.http_call(&source.uri(), "GET", None).await.unwrap().0,
            302
        );
        assert!(
            check_target(&"http://[::ffff:127.0.0.1]/".parse().unwrap(), &[])
                .await
                .is_err()
        );
    }
}
