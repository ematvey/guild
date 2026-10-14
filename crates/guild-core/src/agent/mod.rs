//! Agent-level types shared by the durable gateway workflow's clients:
//! the approval decision and the approval policy (`policy`, spec §3.2).
//! The in-memory agent loop (`run_agent`) is gone — the durable
//! conversation harness (TS server, pi-durable) drives the loop.

pub mod policy;

/// The decision a client (or policy) renders for one tool call awaiting
/// approval. The engine protocol's `agent.approve` resolves pending
/// approvals into this type; the workflow's dispatch side consumes it.
pub enum ApprovalDecision {
    Approve,
    Deny { reason: String },
}
