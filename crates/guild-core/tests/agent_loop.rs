use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use guild_core::agent::{
    policy::ApprovalPolicy, run_agent, AgentConfig, AgentHooks, ApprovalDecision, ModelTurn,
};
use guild_core::provider::{ProviderChunk, ProviderError};
use guild_core::tools::ToolRegistry;
use protocol::api::{Message, ToolCall, ToolSpec};
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Scripted fake: yields canned chunk sequences in order.
struct ScriptedTurn {
    turns: Mutex<Vec<Vec<ProviderChunk>>>,
}

impl ScriptedTurn {
    fn new(turns: Vec<Vec<ProviderChunk>>) -> Self {
        Self {
            turns: Mutex::new(turns),
        }
    }
}

#[async_trait]
impl ModelTurn for ScriptedTurn {
    async fn stream_turn(
        &self,
        _messages: &[Message],
        _tools: &[ToolSpec],
    ) -> Result<BoxStream<'static, Result<ProviderChunk, ProviderError>>, ProviderError> {
        let next = self.turns.lock().unwrap().remove(0);
        Ok(futures::stream::iter(next.into_iter().map(Ok)).boxed())
    }
}

#[derive(Default)]
struct Recorder {
    log: Mutex<Vec<String>>,
}

impl Recorder {
    fn push(&self, s: String) {
        self.log.lock().unwrap().push(s);
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

#[async_trait]
impl AgentHooks for Recorder {
    async fn on_text(&self, delta: &str) {
        self.push(format!("text:{delta}"));
    }
    async fn on_tool_call(&self, call: &ToolCall) {
        self.push(format!("call:{} {}", call.name, call.arguments));
    }
    async fn on_tool_result(
        &self,
        call: &ToolCall,
        outcome: &Result<guild_core::tools::ToolOutcome, guild_core::tools::ToolFailure>,
    ) {
        let body = match outcome {
            Ok(o) => o.output_for_model.clone(),
            Err(e) => format!("FAILED: {e}"),
        };
        self.push(format!("result:{} {body}", call.name));
    }
    async fn request_approval(&self, call: &ToolCall) -> ApprovalDecision {
        self.push(format!("approval_requested:{}", call.name));
        ApprovalDecision::Approve
    }
    async fn on_done(&self, summary: &str) {
        self.push(format!("done:{summary}"));
    }
}

fn text(s: &str) -> ProviderChunk {
    ProviderChunk::Text(guild_core::provider::ChatChunk {
        text_delta: s.into(),
        tokens_in: None,
        tokens_out: None,
    })
}

#[tokio::test]
async fn loop_runs_tool_then_finishes() {
    let turn = ScriptedTurn::new(vec![
        vec![
            text("let me check "),
            text("the file."),
            ProviderChunk::ToolCallDone {
                call: ToolCall {
                    id: "c1".into(),
                    name: "read_file".into(),
                    arguments: json!({"path": "a.txt"}),
                },
            },
        ],
        vec![text("The file says hi.")],
    ]);
    let dir = std::env::temp_dir().join(format!("guild-agent-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "hi").unwrap();

    let hooks = Recorder::default();
    let mut history = vec![Message::user("read a.txt")];
    let result = run_agent(
        &turn,
        &ToolRegistry::builtins(),
        &ApprovalPolicy::default(),
        &mut history,
        &dir,
        &hooks,
        &AgentConfig::default(),
    )
    .await
    .unwrap();

    assert_eq!(result.final_text, "The file says hi.");
    assert!(!result.stopped_at_max_steps);
    let log = hooks.log();
    assert_eq!(log[0], "text:let me check ");
    assert!(log
        .iter()
        .any(|l| l == "call:read_file {\"path\":\"a.txt\"}"));
    assert!(log.iter().any(|l| l.starts_with("result:read_file hi")));
    assert!(log.last().unwrap().starts_with("done:"));

    // replayable history: user, assistant(tool_calls), tool, assistant
    assert_eq!(history.len(), 4);
    assert_eq!(history[1].role, "assistant");
    assert_eq!(history[1].tool_calls.as_ref().unwrap()[0].id, "c1");
    assert_eq!(history[2].role, "tool");
    assert_eq!(history[2].tool_call_id.as_deref(), Some("c1"));
    assert_eq!(history[3].content, "The file says hi.");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn policy_never_denies_without_asking() {
    let turn = ScriptedTurn::new(vec![
        vec![ProviderChunk::ToolCallDone {
            call: ToolCall {
                id: "c2".into(),
                name: "run_command".into(),
                arguments: json!({"command": "rm -rf /"}),
            },
        }],
        vec![text("never mind.")],
    ]);
    let mut policy = ApprovalPolicy::default();
    policy
        .overrides
        .insert("run_command".into(), guild_core::tools::Approval::Never);

    let hooks = Recorder::default();
    let mut history = vec![Message::user("do it")];
    let dir = std::env::temp_dir();
    let result = run_agent(
        &turn,
        &ToolRegistry::builtins(),
        &policy,
        &mut history,
        &dir,
        &hooks,
        &AgentConfig::default(),
    )
    .await
    .unwrap();
    let log = hooks.log();
    assert!(
        !log.iter().any(|l| l.starts_with("approval_requested")),
        "never-policy must not ask: {log:?}"
    );
    assert!(log.iter().any(|l| l.contains("disabled by policy")));
    assert_eq!(result.final_text, "never mind.");
}

#[tokio::test]
async fn approval_deny_reaches_model_as_tool_result() {
    struct Denier;
    #[async_trait]
    impl AgentHooks for Denier {
        async fn on_text(&self, _: &str) {}
        async fn on_tool_call(&self, _: &ToolCall) {}
        async fn on_tool_result(
            &self,
            _: &ToolCall,
            _: &Result<guild_core::tools::ToolOutcome, guild_core::tools::ToolFailure>,
        ) {
        }
        async fn request_approval(&self, _: &ToolCall) -> ApprovalDecision {
            ApprovalDecision::Deny {
                reason: "too dangerous".into(),
            }
        }
        async fn on_done(&self, _: &str) {}
    }

    let turn = ScriptedTurn::new(vec![
        vec![ProviderChunk::ToolCallDone {
            call: ToolCall {
                id: "c3".into(),
                name: "run_command".into(),
                arguments: json!({"command": "x"}),
            },
        }],
        vec![text("understood, skipping.")],
    ]);
    let hooks = Denier;
    let mut history = vec![Message::user("go")];
    let result = run_agent(
        &turn,
        &ToolRegistry::builtins(),
        &ApprovalPolicy::default(),
        &mut history,
        Path::new("/tmp"),
        &hooks,
        &AgentConfig::default(),
    )
    .await
    .unwrap();
    assert_eq!(result.final_text, "understood, skipping.");
    assert_eq!(
        history[2].content,
        "tool failed: execution failed: denied by user: too dangerous"
    );
}

#[tokio::test]
async fn max_steps_stops_cleanly() {
    // every turn returns a tool call → must stop at max_steps
    let turn = ScriptedTurn::new(
        (0..10)
            .map(|i| {
                vec![ProviderChunk::ToolCallDone {
                    call: ToolCall {
                        id: format!("c{i}"),
                        name: "read_file".into(),
                        arguments: json!({"path": "a"}),
                    },
                }]
            })
            .collect(),
    );
    let hooks = Recorder::default();
    let mut history = vec![Message::user("loop forever")];
    let dir = std::env::temp_dir();
    let result = run_agent(
        &turn,
        &ToolRegistry::builtins(),
        &ApprovalPolicy::default(),
        &mut history,
        &dir,
        &hooks,
        &AgentConfig {
            max_steps: 3,
            system_prompt: None,
        },
    )
    .await
    .unwrap();
    assert!(result.stopped_at_max_steps);
    assert_eq!(result.steps, 4); // 3 executed + 1 refused
}

#[tokio::test]
async fn tool_failure_becomes_model_readable_result() {
    let turn = ScriptedTurn::new(vec![
        vec![ProviderChunk::ToolCallDone {
            call: ToolCall {
                id: "c4".into(),
                name: "read_file".into(),
                arguments: json!({"path": "missing.txt"}),
            },
        }],
        vec![text("noted, it's missing.")],
    ]);
    let hooks = Recorder::default();
    let dir = std::env::temp_dir();
    let mut history = vec![Message::user("read missing.txt")];
    let result = run_agent(
        &turn,
        &ToolRegistry::builtins(),
        &ApprovalPolicy::default(),
        &mut history,
        &dir,
        &hooks,
        &AgentConfig::default(),
    )
    .await
    .unwrap();
    assert_eq!(result.final_text, "noted, it's missing.");
    assert!(history[2].content.starts_with("tool failed:"));
}
