//! Restate bindings for the integrations runtime (spec §4.6). `RoutineRunner`
//! is a virtual object keyed by routine id: webhook payloads and ticks enter
//! here; every nondeterministic step is journaled with `ctx.run` so Restate
//! replays results on retry instead of re-running side effects.
//!
//! The journaled sequence is written once as macros and expanded per concrete
//! context type (`ObjectContext` / `SharedObjectContext`) — generic helpers
//! over the SDK context traits trip rustc's async-fn-in-trait Send inference
//! (rust-lang/rust#100013).

use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;
use crate::worker::executor::{tool_registry, Completion, RoutineConfig, RoutineExecutor};
use crate::worker::run::MAX_STEPS;
use protocol::api::Message;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde_json::{json, Value};
use uuid::Uuid;

/// Virtual object: key = routine id (string form).
pub struct RoutineRunner {
    pub state: AppState,
}

impl RoutineRunner {
    fn executor(&self) -> RoutineExecutor {
        RoutineExecutor {
            api_base: self.state.config.api_url.trim_end_matches('/').to_string(),
            internal_token: self
                .state
                .config
                .internal_token
                .clone()
                .expect("worker role requires GUILD_INTERNAL_TOKEN"),
            allow_http_tool: std::env::var("GUILD_WORKER_ALLOW_HTTP")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false),
        }
    }
}

/// Journaled config load; a disabled routine is a terminal error (stops the
/// interval chain instead of retrying forever).
macro_rules! journaled_load_config {
    ($ctx:expr, $exec:expr, $routine_id:expr) => {{
        let exec2 = ($exec).clone();
        $ctx.run(move || {
            let exec = exec2.clone();
            async move {
                let cfg = exec.load_config($routine_id).await?;
                if !cfg.enabled {
                    return Err(TerminalError::new("routine disabled").into());
                }
                Ok(Json(cfg))
            }
        })
        .await?
        .into_inner()
    }};
}

/// Journaled run body: open the run record, run the ReAct loop with per-step
/// journaling, close the record. Yields `HandlerResult<()>`.
macro_rules! journaled_run_body {
    ($ctx:expr, $exec:expr, $cfg:expr, $trigger:expr, $input:expr) => {{
        let exec: RoutineExecutor = ($exec).clone();
        let cfg: RoutineConfig = ($cfg).clone();
        let trigger: &'static str = $trigger;
        let input: Value = $input;

        // Journaled: open the run record.
        let exec2 = exec.clone();
        let run_id: Uuid = $ctx
            .run(move || {
                let exec = exec2.clone();
                async move {
                    let run_id = exec.start_run(cfg.id, trigger).await?;
                    Ok(Json(run_id))
                }
            })
            .await?
            .into_inner();

        let allowed: Vec<String> =
            serde_json::from_value(cfg.allowed_tools.clone()).unwrap_or_default();
        let registry: Arc<guild_core::tools::ToolRegistry> =
            Arc::new(tool_registry(&exec, cfg.org_id, &allowed));
        let specs = registry.specs();
        let user_id = cfg.created_by.unwrap_or(cfg.org_id);

        let opening = if trigger == "webhook" && !input.is_null() {
            format!(
                "Webhook fired with payload:\n{}",
                serde_json::to_string_pretty(&input)?
            )
        } else {
            "Scheduled run: check your sources and report.".to_string()
        };
        let mut messages = vec![Message::user(opening)];
        let mut completion: Option<Completion> = None;

        for _step in 0..MAX_STEPS {
            // Journaled: one model call.
            let exec2 = exec.clone();
            let msgs = messages.clone();
            let specs2 = specs.clone();
            let model = cfg.model.clone();
            let system = Some(cfg.prompt.clone());
            let org = cfg.org_id;
            let c: Completion = $ctx
                .run(move || {
                    let exec = exec2.clone();
                    let messages = msgs.clone();
                    let specs = specs2.clone();
                    async move {
                        let c = exec
                            .completion(org, user_id, &model, system, messages, specs)
                            .await?;
                        Ok(Json(c))
                    }
                })
                .await?
                .into_inner();

            if c.tool_calls.is_empty() {
                completion = Some(c);
                break;
            }
            messages.push(Message {
                role: "assistant".into(),
                content: c.text.clone(),
                tool_calls: Some(c.tool_calls.clone()),
                tool_call_id: None,
            });
            for call in c.tool_calls {
                // Journaled: one tool execution; failures become tool results.
                let registry2 = registry.clone();
                let call_name = call.name.clone();
                let call_id = call.id.clone();
                let args = call.arguments.clone();
                let content: String = $ctx
                    .run(move || {
                        let registry = registry2.clone();
                        let name = call_name.clone();
                        let args = args.clone();
                        async move {
                            let result = registry.run(&name, std::path::Path::new("/"), args).await;
                            let content = match result {
                                Ok(out) => out.output_for_model,
                                Err(e) => format!("tool {name} failed: {e}"),
                            };
                            Ok(Json(content))
                        }
                    })
                    .await?
                    .into_inner();
                messages.push(Message::tool_result(&call_id, &content));
            }
        }

        let summary = match completion {
            Some(c) => c.text,
            None => {
                let msg = format!("routine hit the {MAX_STEPS}-step limit without a final answer");
                finish_run_journaled!($ctx, exec, run_id, "failed", Some(msg.clone()), None);
                return Err(TerminalError::new(msg).into());
            }
        };

        finish_run_journaled!($ctx, exec, run_id, "succeeded", None, Some(summary));
        Ok(())
    }};
}

/// Journaled finish of the run record.
macro_rules! finish_run_journaled {
    ($ctx:expr, $exec:expr, $run_id:expr, $status:expr, $error:expr, $summary:expr) => {{
        let exec2 = $exec.clone();
        let error: Option<String> = $error;
        let summary: Option<String> = $summary;
        $ctx.run(move || {
            let exec = exec2.clone();
            async move {
                exec.finish_run($run_id, $status, summary.as_deref(), error.as_deref())
                    .await?;
                Ok(Json(()))
            }
        })
        .await?;
    }};
}

#[object]
impl RoutineRunner {
    /// Webhook trigger: the API forwarded a one-way send here.
    #[handler]
    async fn handle_webhook(
        &self,
        ctx: SharedObjectContext<'_>,
        payload: Json<Value>,
    ) -> HandlerResult<()> {
        let routine_id: Uuid = ctx.key().parse().map_err(anyhow::Error::msg)?;
        let exec = self.executor();
        let cfg = journaled_load_config!(ctx, exec, routine_id);
        journaled_run_body!(ctx, exec, cfg, "webhook", payload.into_inner())
    }

    /// Interval trigger: check enabled, reschedule ourselves, then run.
    /// The enabled check happens first so a disabled routine ends its chain.
    #[handler]
    async fn tick(&self, ctx: ObjectContext<'_>, interval_secs: Json<u64>) -> HandlerResult<()> {
        let interval = interval_secs.into_inner().max(1);
        let routine_id: Uuid = ctx.key().parse().map_err(anyhow::Error::msg)?;
        let exec = self.executor();
        let cfg = journaled_load_config!(ctx, exec, routine_id); // terminal when disabled → chain ends
        ctx.object_client::<RoutineRunnerClient>(ctx.key())
            .tick(Json(interval))
            .send_after(Duration::from_secs(interval));
        journaled_run_body!(ctx, exec, cfg, "interval", json!({}))
    }
}

/// Register this worker's endpoint with the Restate admin API (retry until
/// accepted or already registered).
pub async fn register_with_restate(admin_url: &str, advertised_url: &str) -> anyhow::Result<()> {
    let url = format!("{}/deployments", admin_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    for _ in 0..150 {
        let resp = client
            .post(&url)
            .json(&json!({"uri": advertised_url}))
            .send()
            .await?;
        if resp.status().is_success() || resp.status().as_u16() == 409 {
            return Ok(());
        }
        tracing::warn!(
            "restate endpoint registration got {}; retrying",
            resp.status()
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    anyhow::bail!("could not register worker endpoint with restate at {url}")
}

/// Spawn the Restate endpoint server for the worker role.
pub async fn spawn_worker(state: AppState) -> anyhow::Result<()> {
    if state.config.internal_token.is_none() {
        anyhow::bail!("worker role requires GUILD_INTERNAL_TOKEN");
    }
    let bind = state
        .config
        .worker_bind
        .parse()
        .map_err(|e| anyhow::anyhow!("bad GUILD_WORKER_BIND: {e}"))?;
    let admin = state.config.restate_admin_url.clone();
    let advertised = state.config.worker_advertised_url.clone();
    // Listen first: Restate probes the advertised URI during registration.
    let server = tokio::spawn(async move {
        HttpServer::new(Endpoint::builder().bind(RoutineRunner { state }).build())
            .listen_and_serve(bind)
            .await;
    });
    register_with_restate(&admin, &advertised).await?;
    server.await?;
    Ok(())
}
