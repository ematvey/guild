//! Static exec policy for machine `execute` calls, ahead of the approval
//! gate: codex-style Starlark prefix rules decide the obvious bands so the
//! judge only sees genuinely uncertain commands.
//!
//! Decision mapping (mirrors openai/codex): a matched `allow` rule skips the
//! gate entirely; a matched `forbidden` rule is a hard deny whose text is the
//! rule's justification (the model recovers by trying a materially different
//! command, never by escalating); `prompt` rules and unmatched commands fall
//! through to the chat's approval flow. Rules are compile-time embedded, so
//! the decision is a pure function of (binary, command) — identical under
//! Restate replay.

use codex_execpolicy::{Decision, Policy, PatternToken, RuleMatch};
use std::sync::LazyLock;

const PARSED_RULES: &str = include_str!(concat!(env!("OUT_DIR"), "/exec_policy_rules.json"));

static POLICY: LazyLock<Policy> = LazyLock::new(|| {
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum RestToken {
        Single(String),
        Alts(Vec<String>),
    }

    #[derive(serde::Deserialize)]
    struct RuleSpec {
        first: String,
        rest: Vec<RestToken>,
        decision: String,
        justification: Option<String>,
    }

    let specs: Vec<RuleSpec> =
        serde_json::from_str(PARSED_RULES).expect("build-script exec policy JSON parses");
    let mut policy = Policy::empty();
    for spec in specs {
        let decision = match spec.decision.as_str() {
            "allow" => Decision::Allow,
            "forbidden" => Decision::Forbidden,
            _ => Decision::Prompt,
        };
        let rest = spec
            .rest
            .into_iter()
            .map(|token| match token {
                RestToken::Single(s) => PatternToken::Single(s),
                RestToken::Alts(alts) => PatternToken::Alts(alts),
            })
            .collect();
        policy
            .add_prefix_rule_pattern(&spec.first, rest, decision, spec.justification)
            .expect("reconstructed rule is well-formed");
    }
    policy
});

/// The static layer's verdict for one `execute` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecPolicyDecision {
    /// A rule allows this command — run it without the approval gate.
    Allow,
    /// A rule forbids this command — deny with the rule's justification.
    Deny(String),
    /// No rule decides — the chat's approval flow (judge / card) applies.
    Prompt,
}

/// Evaluates the machine `execute` tool arguments against the static policy.
pub fn evaluate_execute(arguments: &serde_json::Value) -> ExecPolicyDecision {
    let Some(command) = arguments.get("command").and_then(|v| v.as_str()) else {
        return ExecPolicyDecision::Prompt;
    };
    evaluate_command(command)
}

fn evaluate_command(command: &str) -> ExecPolicyDecision {
    let Some(tokens) = shlex::split(command) else {
        return ExecPolicyDecision::Prompt;
    };
    let segments = split_segments(&tokens);
    if segments.is_empty() {
        return ExecPolicyDecision::Prompt;
    }
    // Redirection writes files; a prefix rule that matches the leading
    // command must not wave the write through.
    if segments
        .iter()
        .any(|s| s.iter().any(|t| matches!(t.as_str(), "<" | ">" | ">>" | "<<")))
    {
        return ExecPolicyDecision::Prompt;
    }
    let evaluation = POLICY.check_multiple(
        segments.iter().map(|s| s.as_slice()),
        &|_unmatched| Decision::Prompt,
    );
    match evaluation.decision {
        Decision::Allow => ExecPolicyDecision::Allow,
        Decision::Prompt => ExecPolicyDecision::Prompt,
        Decision::Forbidden => {
            let justification = evaluation
                .matched_rules
                .iter()
                .filter_map(|m| match m {
                    RuleMatch::PrefixRuleMatch { justification, decision, .. }
                        if *decision == Decision::Forbidden =>
                    {
                        justification.clone()
                    }
                    _ => None,
                })
                .next()
                .unwrap_or_else(|| "denied by exec policy".to_string());
            ExecPolicyDecision::Deny(justification)
        }
    }
}

/// Splits the token stream at shell control operators — each segment is
/// evaluated independently, like codex's command segmentation.
fn split_segments(tokens: &[String]) -> Vec<Vec<String>> {
    let mut segments: Vec<Vec<String>> = vec![Vec::new()];
    for token in tokens {
        match token.as_str() {
            "&&" | "||" | ";" | "|" => segments.push(Vec::new()),
            _ => segments.last_mut().expect("segments never empty").push(token.clone()),
        }
    }
    segments.into_iter().filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::evaluate_execute;
    use super::ExecPolicyDecision;
    use serde_json::json;

    fn exec(command: &str) -> ExecPolicyDecision {
        evaluate_execute(&json!({ "command": command }))
    }

    #[test]
    fn allow_rule_runs_without_a_gate() {
        assert!(matches!(exec("date"), ExecPolicyDecision::Allow));
        assert!(matches!(exec("git status"), ExecPolicyDecision::Allow));
    }

    #[test]
    fn deny_rule_blocks_with_the_justification() {
        match exec("dd if=/dev/sda of=/dev/null") {
            ExecPolicyDecision::Deny(reason) => {
                assert!(reason.contains("destructive and irreversible"), "{reason}");
            }
            other => panic!("expected Deny, got {other:?}"),
        }
    }

    #[test]
    fn ordinary_destructive_commands_stay_with_the_judge() {
        // rm is judge territory, not a static deny — the base policy only
        // hard-blocks unambiguous catastrophic patterns.
        assert!(matches!(exec("rm -rf /"), ExecPolicyDecision::Prompt));
    }

    #[test]
    fn strictest_segment_wins_in_compound_commands() {
        assert!(matches!(
            exec("git status && dd if=/dev/sda of=/dev/null"),
            ExecPolicyDecision::Deny(_)
        ));
    }

    #[test]
    fn redirection_never_auto_approves() {
        assert!(matches!(exec("echo hi > /tmp/x"), ExecPolicyDecision::Prompt));
    }

    #[test]
    fn unmatched_commands_fall_to_the_gate() {
        assert!(matches!(exec("blinkenlights --now"), ExecPolicyDecision::Prompt));
    }

    #[test]
    fn local_rules_layer_matches() {
        assert!(matches!(
            exec("journalctl --user -u docker"),
            ExecPolicyDecision::Allow
        ));
    }

    #[test]
    fn untokenizable_commands_fall_to_the_gate() {
        assert!(matches!(exec("echo \"unterminated"), ExecPolicyDecision::Prompt));
    }

    #[test]
    fn missing_command_argument_falls_to_the_gate() {
        assert!(matches!(
            evaluate_execute(&json!({ "cwd": "x" })),
            ExecPolicyDecision::Prompt
        ));
    }
}
