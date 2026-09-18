//! Agent-session plumbing shared by the shim (agent_start.rs) and the RPC
//! surface: the pending-approval registry `agent.approve` resolves.

use guild_core::agent::ApprovalDecision;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// Client-tool calls awaiting an approval decision, by call id. The shim
/// inserts a oneshot per `ApprovalRequested` frame; `agent.approve`
/// removes and resolves it.
pub type PendingApprovals = Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>;
