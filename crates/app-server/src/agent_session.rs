//! Agent-session plumbing shared by the shim (agent_start.rs) and the RPC
//! surface: the approval policy `agent.policy.*` edits, the decision
//! `agent.approve` renders, and the pending-approval registry it resolves.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// One tool's approval verdict (spec §3.2: always / never / ask).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Allow,
    Ask,
    Never,
}

/// The decision an engine client renders for one tool call awaiting
/// approval (`agent.approve`).
pub enum ApprovalDecision {
    Approve,
    Deny { reason: String },
}

/// The session's approval policy: per-tool overrides over a policy-wide
/// default.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, Default)]
pub struct ApprovalPolicy {
    /// Used when no override names the tool.
    #[serde(default)]
    pub default: Option<Approval>,
    #[serde(default)]
    pub overrides: HashMap<String, Approval>,
}

impl ApprovalPolicy {
    /// Effective verdict for a tool: an explicit override wins, then the
    /// policy default, then Ask.
    pub fn for_tool(&self, name: &str) -> Approval {
        self.overrides
            .get(name)
            .copied()
            .or(self.default)
            .unwrap_or(Approval::Ask)
    }
}

/// Client-tool calls awaiting an approval decision, by call id. The shim
/// inserts a oneshot per `ApprovalRequested` frame; `agent.approve`
/// removes and resolves it.
pub type PendingApprovals = Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_then_default_then_ask() {
        let mut p = ApprovalPolicy::default();
        assert_eq!(p.for_tool("execute"), Approval::Ask);
        p.overrides.insert("execute".into(), Approval::Never);
        p.default = Some(Approval::Allow);
        assert_eq!(p.for_tool("execute"), Approval::Never);
        assert_eq!(p.for_tool("read_file"), Approval::Allow);
    }

    #[test]
    fn serde_roundtrip() {
        let mut p = ApprovalPolicy {
            default: Some(Approval::Allow),
            ..Default::default()
        };
        p.overrides.insert("write_file".into(), Approval::Ask);
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<ApprovalPolicy>(&s).unwrap(), p);
    }
}
