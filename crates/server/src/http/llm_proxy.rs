//! Shared pipeline for the public LLM gateway endpoints
//! (`/openai/v1/chat/completions`, `/anthropic/v1/messages`): API key auth
//! (per-endpoint extractor) → org route resolution → quota → provider
//! stream. Each endpoint renders errors in its own wire shape and records
//! usage against the key's owner.

use crate::http::error::ApiError;
use crate::state::AppState;
use axum::http::StatusCode;
use futures::StreamExt;
use guild_core::provider::{for_protocol, ProviderChunk, ProviderRequest};
use protocol::api::{Message, ToolSpec};
use std::sync::Arc;
use uuid::Uuid;

/// Endpoint-neutral failure; each gateway surface renders it in its own
/// error contract (OpenAI `{"error": …}` vs Anthropic `{"type":"error",…}`).
pub struct ProxyError(pub ApiError);

impl From<ApiError> for ProxyError {
    fn from(e: ApiError) -> Self {
        ProxyError(e)
    }
}

impl ProxyError {
    pub fn status(&self) -> StatusCode {
        self.0.status
    }

    /// The OpenAI error `type` string for the failure class.
    pub fn openai_type(&self) -> &'static str {
        match self.0.code.as_str() {
            "quota_exceeded" => "quota_exceeded",
            "not_found" => "invalid_request_error",
            _ => "invalid_request_error",
        }
    }

    /// The Anthropic error `type` string for the failure class.
    pub fn anthropic_type(&self) -> &'static str {
        match self.0.code.as_str() {
            "not_found" => "not_found_error",
            "unauthorized" => "authentication_error",
            "quota_exceeded" => "rate_limit_error",
            _ => "api_error",
        }
    }
}

pub struct RoutedCall {
    pub stream: futures::stream::BoxStream<
        'static,
        Result<ProviderChunk, guild_core::provider::ProviderError>,
    >,
    pub model: String,
    pub provider: String,
    pub price_in: f64,
    pub price_out: f64,
    pub usage: Arc<crate::usage::UsageSink>,
}

/// Resolves the org route for `model`, enforces the route quota, and opens
/// the provider stream. Model scoping is the same as in-app chat: whatever
/// the org's route table resolves.
pub async fn dispatch(
    state: &AppState,
    org_id: Uuid,
    model: &str,
    system: Option<String>,
    messages: Vec<Message>,
    tools: Option<Vec<ToolSpec>>,
    client_max_tokens: Option<i64>,
) -> Result<RoutedCall, ProxyError> {
    let store = state.store().await?;
    let master = state
        .config
        .master_key()
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let route = store
        .gateway()
        .resolve_route(org_id, model, &master)
        .await?;

    crate::http::gateway::enforce_quota(state, org_id, model, &route).await?;

    let provider: Arc<dyn guild_core::provider::ModelProvider> = for_protocol(&route.protocol)
        .ok_or_else(|| ApiError::internal(format!("unknown protocol {}", route.protocol)))?;
    // Route cap wins; the client's max_tokens applies when the route
    // doesn't set one (0 = provider default).
    let max_tokens = route
        .max_output_tokens
        .or(client_max_tokens)
        .unwrap_or(0)
        .max(0) as u32;
    let preq = ProviderRequest {
        model,
        system: system.as_deref(),
        messages: &messages,
        api_key: &route.api_key,
        base_url: &route.base_url,
        tools: tools.as_deref(),
        max_tokens,
    };
    let stream = provider.chat_stream(preq).await.map_err(|e| {
        ProxyError(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "provider_error",
            e.to_string(),
        ))
    })?;

    Ok(RoutedCall {
        stream,
        model: model.to_string(),
        provider: route.provider,
        price_in: route.price_in,
        price_out: route.price_out,
        usage: state.usage().await?,
    })
}

/// Usage row for a completed gateway call (key owner attribution: the key's
/// owner when user-minted, else the admin who created it).
#[allow(clippy::too_many_arguments)]
pub fn usage_event(
    org_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
    model: &str,
    provider: &str,
    price_in: f64,
    price_out: f64,
    tokens_in: u32,
    tokens_out: u32,
) -> guild_core::usage::UsageEvent {
    guild_core::usage::UsageEvent {
        ts: chrono::Utc::now(),
        org_id,
        user_id,
        team_id: None,
        session_id,
        model: model.to_string(),
        provider: provider.to_string(),
        tokens_in,
        tokens_out,
        cost_usd: guild_core::usage::UsageEvent::cost_usd(
            tokens_in, tokens_out, price_in, price_out,
        ),
        request_id: Uuid::now_v7(),
    }
}

/// Usage counters a gateway stream loop updates per frame; the guard reads
/// them at drop.
#[derive(Clone)]
pub(crate) struct StreamUsageCounters {
    tokens_in: Arc<std::sync::atomic::AtomicU32>,
    tokens_out: Arc<std::sync::atomic::AtomicU32>,
}

impl StreamUsageCounters {
    /// Provider usage frames carry absolute totals.
    pub(crate) fn set(&self, tokens_in: Option<u32>, tokens_out: Option<u32>) {
        if let Some(n) = tokens_in {
            self.tokens_in
                .store(n, std::sync::atomic::Ordering::SeqCst);
        }
        if let Some(n) = tokens_out {
            self.tokens_out
                .store(n, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

/// Records a gateway stream's usage on every exit path. Normal completion
/// records synchronously (disarming the guard) before the final frame; a
/// client disconnect drops the body and a provider error returns early —
/// the drop then records the running counts instead.
pub(crate) struct StreamUsageGuard {
    usage: Arc<crate::usage::UsageSink>,
    org_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
    model: String,
    provider: String,
    price_in: f64,
    price_out: f64,
    counters: StreamUsageCounters,
    armed: bool,
}

impl StreamUsageGuard {
    pub(crate) fn new(
        usage: Arc<crate::usage::UsageSink>,
        org_id: Uuid,
        user_id: Uuid,
        session_id: Uuid,
        model: String,
        provider: String,
        price_in: f64,
        price_out: f64,
    ) -> Self {
        Self {
            counters: StreamUsageCounters {
                tokens_in: Arc::new(std::sync::atomic::AtomicU32::new(0)),
                tokens_out: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            },
            usage,
            org_id,
            user_id,
            session_id,
            model,
            provider,
            price_in,
            price_out,
            armed: true,
        }
    }

    pub(crate) fn counters(&self) -> StreamUsageCounters {
        self.counters.clone()
    }

    /// Records synchronously and disarms the drop-path record — the normal
    /// completion path, where usage must be durable before the final frame
    /// yields (quota checks and tests read right after the stream ends).
    pub(crate) async fn record_sync(mut self) {
        self.armed = false;
        let ev = self.event();
        self.usage.record(ev).await;
    }

    fn event(&self) -> guild_core::usage::UsageEvent {
        usage_event(
            self.org_id,
            self.user_id,
            self.session_id,
            &self.model,
            &self.provider,
            self.price_in,
            self.price_out,
            self.counters.tokens_in.load(std::sync::atomic::Ordering::SeqCst),
            self.counters.tokens_out.load(std::sync::atomic::Ordering::SeqCst),
        )
    }
}

impl Drop for StreamUsageGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let ev = self.event();
        let usage = self.usage.clone();
        tokio::spawn(async move {
            usage.record(ev).await;
        });
    }
}

/// Drains the provider stream, folding tool-call fragments into complete
/// calls (the streaming endpoints emit fragments themselves, the
/// non-streaming ones use this). Returns (text, calls, tokens_in, tokens_out).
pub async fn accumulate(
    stream: futures::stream::BoxStream<
        'static,
        Result<ProviderChunk, guild_core::provider::ProviderError>,
    >,
) -> anyhow::Result<(String, Vec<protocol::api::ToolCall>, u32, u32)> {
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut tokens_in = 0u32;
    let mut tokens_out = 0u32;
    let mut pinned = Box::pin(stream);
    while let Some(item) = pinned.next().await {
        match item? {
            ProviderChunk::Text(t) => {
                text.push_str(&t.text_delta);
                if let Some(n) = t.tokens_in {
                    tokens_in = n;
                }
                if let Some(n) = t.tokens_out {
                    tokens_out = n;
                }
            }
            ProviderChunk::ToolCallDelta { .. } => {}
            ProviderChunk::Thinking(_) => {}
            ProviderChunk::ToolCallDone { call } => calls.push(call),
        }
    }
    Ok((text, calls, tokens_in, tokens_out))
}
