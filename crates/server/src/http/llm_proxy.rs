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
    // The tighter limit wins when both sides set one: a client asking for
    // less than the route cap must not be billed for output it did not ask
    // for (0 = provider default).
    let max_tokens = match (route.max_output_tokens, client_max_tokens) {
        (Some(route_cap), Some(client)) => Some(route_cap.min(client)),
        (route_cap, client) => route_cap.or(client),
    }
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
    /// Provider frames seen — a stream that produced anything counts as a
    /// billable request even if the usage totals never arrived (abort).
    frames: Arc<std::sync::atomic::AtomicU32>,
}

impl StreamUsageCounters {
    /// Marks a provider frame as observed (every chunk, usage or not).
    pub(crate) fn observe(&self) {
        self.frames
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Provider usage frames carry absolute totals.
    pub(crate) fn set(&self, tokens_in: Option<u32>, tokens_out: Option<u32>) {
        if let Some(n) = tokens_in {
            self.tokens_in.store(n, std::sync::atomic::Ordering::SeqCst);
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
/// the drop then records the running counts instead. A stream that produced
/// nothing (provider error before the first frame) records nothing.
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
    request_id: Uuid,
}

impl StreamUsageGuard {
    #[allow(clippy::too_many_arguments)]
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
                frames: Arc::new(std::sync::atomic::AtomicU32::new(0)),
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
            request_id: Uuid::now_v7(),
        }
    }

    pub(crate) fn with_request_id(mut self, request_id: Uuid) -> Self {
        self.request_id = request_id;
        self
    }

    pub(crate) fn disarm(mut self) {
        self.armed = false;
    }

    pub(crate) fn counters(&self) -> StreamUsageCounters {
        self.counters.clone()
    }

    /// Records synchronously and disarms the drop-path record — the normal
    /// completion path, where usage must be durable before the final frame
    /// yields (quota checks and tests read right after the stream ends).
    pub(crate) async fn record_sync(mut self) {
        let ev = self.event();
        let usage = self.usage.clone();
        let recording = tokio::spawn(async move { usage.record(ev).await });
        self.armed = false;
        // Dropping the HTTP body detaches this owned task instead of cancelling the insert.
        let _ = recording.await;
    }

    fn event(&self) -> guild_core::usage::UsageEvent {
        let mut event = usage_event(
            self.org_id,
            self.user_id,
            self.session_id,
            &self.model,
            &self.provider,
            self.price_in,
            self.price_out,
            self.counters
                .tokens_in
                .load(std::sync::atomic::Ordering::SeqCst),
            self.counters
                .tokens_out
                .load(std::sync::atomic::Ordering::SeqCst),
        );
        event.request_id = self.request_id;
        event
    }
}

impl Drop for StreamUsageGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // A provider error before any frame (or a client disconnect before
        // the first chunk) observed nothing billable — writing a 0-token
        // row would inflate per-request counts. An aborted stream that
        // already produced frames still records (a request was served).
        if self
            .counters
            .frames
            .load(std::sync::atomic::Ordering::SeqCst)
            == 0
        {
            return;
        }
        let ev = self.event();
        let usage = self.usage.clone();
        tokio::spawn(async move {
            usage.record(ev).await;
        });
    }
}

/// What a drained provider stream produced: the model-facing content, the
/// terminal finish reason (canonical OpenAI vocabulary, when the provider
/// reported one), and usage totals.
pub(crate) struct Accumulated {
    pub text: String,
    pub reasoning: String,
    pub calls: Vec<protocol::api::ToolCall>,
    pub finish_reason: Option<String>,
    pub tokens_in: u32,
    pub tokens_out: u32,
}

/// Drains the provider stream, folding tool-call fragments into complete
/// calls (the streaming endpoints emit fragments themselves, the
/// non-streaming ones use this).
pub(crate) async fn accumulate(
    stream: futures::stream::BoxStream<
        'static,
        Result<ProviderChunk, guild_core::provider::ProviderError>,
    >,
    counters: StreamUsageCounters,
) -> anyhow::Result<Accumulated> {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut calls = Vec::new();
    let mut finish_reason: Option<String> = None;
    let mut tokens_in = 0u32;
    let mut tokens_out = 0u32;
    let mut pinned = Box::pin(stream);
    while let Some(item) = pinned.next().await {
        let item = item?;
        counters.observe();
        if let ProviderChunk::Text(chunk) = &item {
            counters.set(chunk.tokens_in, chunk.tokens_out);
        }
        match item {
            ProviderChunk::Text(t) => {
                text.push_str(&t.text_delta);
                if let Some(n) = t.tokens_in {
                    tokens_in = n;
                }
                if let Some(n) = t.tokens_out {
                    tokens_out = n;
                }
            }
            // Reasoning is preserved end to end (protocol contract: it is
            // never dropped from context): non-streaming clients get it in
            // the response message so they can replay it.
            ProviderChunk::Thinking(t) => reasoning.push_str(&t.text_delta),
            ProviderChunk::ToolCallDelta { .. } => {}
            ProviderChunk::ToolCallDone { call } => calls.push(call),
            ProviderChunk::Finished { reason } => finish_reason = Some(reason),
        }
    }
    Ok(Accumulated {
        text,
        reasoning,
        calls,
        finish_reason,
        tokens_in,
        tokens_out,
    })
}

#[cfg(all(test, feature = "test-support"))]
mod recording_tests {
    use super::*;

    #[tokio::test]
    async fn completed_recording_survives_caller_cancellation() {
        let fs = crate::test_support::full_state().await;
        let usage = fs.state.usage().await.unwrap();
        let guard = StreamUsageGuard::new(
            usage,
            fs.org_id,
            fs.user_id,
            fs.chat_id,
            "test".into(),
            "fixture".into(),
            1.0,
            1.0,
        );
        guard.counters().observe();
        guard.counters().set(Some(5), Some(2));
        assert_eq!(guard.event().request_id, guard.event().request_id);
        let store = fs.store();
        let mut tx = store.pool().begin().await.unwrap();
        sqlx::query("LOCK TABLE teams IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .unwrap();
        // The sink blocks during attribution, after complete totals have transferred
        // into its recording future. Dropping the caller must not cancel that future.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), guard.record_sync())
                .await
                .is_err()
        );
        tx.commit().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let (count, _) = crate::test_support::clickhouse_usage_rows(&fs.state).await;
                if count == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
}
