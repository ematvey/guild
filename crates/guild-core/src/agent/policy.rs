//! Approval policy: per-tool overrides over tool defaults (spec §3.2).

use crate::tools::Approval;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, Default)]
pub struct ApprovalPolicy {
    /// Used when neither the tool nor an override decides.
    #[serde(default)]
    pub default: Option<Approval>,
    #[serde(default)]
    pub overrides: HashMap<String, Approval>,
}

impl ApprovalPolicy {
    /// Effective policy for a tool: explicit override wins, then the tool's
    /// own default, then the policy default, then Ask (safest).
    pub fn for_tool(&self, name: &str, tool_default: Approval) -> Approval {
        if let Some(a) = self.overrides.get(name) {
            return *a;
        }
        self.default.unwrap_or(tool_default)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precedence() {
        let mut p = ApprovalPolicy::default();
        p.overrides.insert("execute".into(), Approval::Never);
        assert_eq!(p.for_tool("execute", Approval::Ask), Approval::Never);
        assert_eq!(p.for_tool("read_file", Approval::Allow), Approval::Allow);
        assert_eq!(p.for_tool("mystery", Approval::Ask), Approval::Ask);
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
