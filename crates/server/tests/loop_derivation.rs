//! ChatRunner loop derivations (spec §A.4, §B.4): events → model-facing
//! history with reasoning replay, and turn/step numbering.

use guild_server::worker::restate::{build_model_history, next_turn};
use protocol::api::{Block, ThreadEvent, UsagePayload};

fn assistant(turn: u32, step: u32, blocks: Vec<Block>) -> ThreadEvent {
    ThreadEvent::AssistantMessage {
        turn,
        step,
        blocks,
        usage: UsagePayload::default(),
        model: "deepseek-test".into(),
        interrupted: None,
    }
}

/// Derivation covers user/assistant/tool shapes; reasoning is carried on the
/// assistant Message (openai.rs replays it as reasoning_content — never
/// dropped, dsh rule); tool_call arguments round-trip from the raw string;
/// system events stay log-only.
#[test]
fn derivation_builds_model_history_with_reasoning_replay() {
    let events = vec![
        ThreadEvent::SystemMessage {
            content: "server prompt".into(),
        },
        ThreadEvent::UserMessage {
            content: "question".into(),
            attachments: Vec::new(),
        },
        assistant(
            1,
            0,
            vec![
                Block::Reasoning {
                    text: "let me think".into(),
                },
                Block::Text {
                    text: "partial".into(),
                },
                Block::ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    arguments: "{\"path\":\"a.rs\"}".into(),
                },
            ],
        ),
        ThreadEvent::ToolResult {
            turn: 1,
            step: 0,
            call_id: "c1".into(),
            name: "read".into(),
            content: "fn main() {}".into(),
            is_error: false,
            meta: None,
            images: Vec::new(),
            kind: None,
            artifact_id: None,
        },
        assistant(
            1,
            1,
            vec![Block::Text {
                text: "final answer".into(),
            }],
        ),
        ThreadEvent::UserMessage {
            content: "again".into(),
            attachments: Vec::new(),
        },
        assistant(
            2,
            0,
            vec![
                Block::Reasoning {
                    text: "second thought".into(),
                },
                Block::Text {
                    text: "done".into(),
                },
            ],
        ),
    ];

    let msgs = build_model_history(&events, &Default::default(), &[]);

    // system events are log-only; everything else maps 1:1
    assert_eq!(msgs.len(), 6, "system message skipped");
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].content, "question");

    // first assistant: reasoning + tool_calls replayed, text concatenated
    assert_eq!(msgs[1].role, "assistant");
    assert_eq!(msgs[1].reasoning.as_deref(), Some("let me think"));
    assert_eq!(msgs[1].content, "partial");
    let calls = msgs[1].tool_calls.as_ref().expect("tool calls carried");
    assert_eq!(calls[0].id, "c1");
    assert_eq!(calls[0].arguments["path"], "a.rs");

    assert_eq!(msgs[2].role, "tool");
    assert_eq!(msgs[2].tool_call_id.as_deref(), Some("c1"));
    assert_eq!(msgs[2].content, "fn main() {}");

    assert_eq!(msgs[3].role, "assistant");
    assert_eq!(msgs[3].content, "final answer");
    assert!(
        msgs[3].reasoning.is_none(),
        "no reasoning blocks → no reasoning replay"
    );

    assert_eq!(msgs[4].role, "user");
    assert_eq!(msgs[4].content, "again");

    // reasoning replay works across turns: the second turn's assistant event
    // derived from stored events carries its reasoning too
    assert_eq!(msgs[5].reasoning.as_deref(), Some("second thought"));
}

/// turn = one client request (max persisted turn + 1); step = model call
/// index within the turn, 0-based (spec §A.2, §B.4).
#[test]
fn turn_numbering_continues_from_events() {
    assert_eq!(next_turn(&[]), 1, "empty thread starts at turn 1");

    let events = vec![
        ThreadEvent::UserMessage {
            content: "q".into(),
            attachments: Vec::new(),
        },
        assistant(1, 0, vec![Block::Text { text: "a".into() }]),
        ThreadEvent::ToolResult {
            turn: 3,
            step: 2,
            call_id: "x".into(),
            name: "bash".into(),
            content: "y".into(),
            is_error: false,
            meta: None,
            kind: None,
            artifact_id: None,
            images: Vec::new(),
        },
        assistant(3, 2, vec![Block::Text { text: "a2".into() }]),
    ];
    assert_eq!(next_turn(&events), 4, "max persisted turn + 1");

    // user/system events do not advance the turn counter
    let no_turns = vec![
        ThreadEvent::SystemMessage {
            content: "s".into(),
        },
        ThreadEvent::UserMessage {
            content: "u".into(),
            attachments: Vec::new(),
        },
    ];
    assert_eq!(next_turn(&no_turns), 1);
}
