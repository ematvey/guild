//! The routine run loop: one routine execution = a bounded ReAct loop over
//! the internal completion endpoint with the routine's allowed tools. Every
//! step is journaled by the Restate caller; this function is plain async.

use crate::worker::executor::{tool_registry, Completion, RoutineExecutor};
use anyhow::Context as _;
use protocol::api::Message;
use serde_json::Value;
use uuid::Uuid;

pub const MAX_STEPS: usize = 10;

/// Execute one routine run end-to-end and record it. Returns the summary.
pub async fn run_routine(
    exec: &RoutineExecutor,
    routine_id: Uuid,
    trigger: &str,
    input: Value,
) -> anyhow::Result<String> {
    let cfg = exec.load_config(routine_id).await.context("load routine")?;
    if !cfg.enabled {
        anyhow::bail!("routine {routine_id} is disabled");
    }
    let run_id = exec.start_run(routine_id, trigger).await?;

    match run_loop(exec, &cfg, trigger, input).await {
        Ok(summary) => {
            exec.finish_run(run_id, "succeeded", Some(&summary), None)
                .await?;
            Ok(summary)
        }
        Err(e) => {
            let msg = format!("{e:#}");
            let _ = exec.finish_run(run_id, "failed", None, Some(&msg)).await;
            Err(e)
        }
    }
}

async fn run_loop(
    exec: &RoutineExecutor,
    cfg: &crate::worker::executor::RoutineConfig,
    trigger: &str,
    input: Value,
) -> anyhow::Result<String> {
    let allowed: Vec<String> =
        serde_json::from_value(cfg.allowed_tools.clone()).unwrap_or_default();
    let registry = tool_registry(exec, cfg.org_id, &allowed);
    let specs = registry.specs();
    let user_id = cfg.created_by.unwrap_or(cfg.org_id); // usage attribution

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
        let c = exec
            .completion(
                cfg.org_id,
                user_id,
                &cfg.model,
                Some(cfg.prompt.clone()),
                messages.clone(),
                specs.clone(),
            )
            .await
            .map_err(anyhow::Error::from)?;
        if c.tool_calls.is_empty() {
            completion = Some(c);
            break;
        }
        messages.push(Message {
            role: "assistant".into(),
            content: c.text.clone(),
            images: Vec::new(),
            audio: Vec::new(),
            tool_calls: Some(c.tool_calls.clone()),
            tool_call_id: None,
            reasoning: None,
        });
        for call in &c.tool_calls {
            let result = registry
                .run(
                    &call.name,
                    std::path::Path::new("/"),
                    call.arguments.clone(),
                )
                .await;
            let content = match result {
                Ok(out) => out.output_for_model,
                Err(e) => format!("tool {} failed: {e}", call.name),
            };
            messages.push(Message::tool_result(&call.id, &content));
        }
    }

    let summary = completion.map(|c| c.text).ok_or_else(|| {
        anyhow::anyhow!(
            "routine hit the {}-step limit without a final answer",
            MAX_STEPS
        )
    })?;
    Ok(summary)
}
