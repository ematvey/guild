//! Server-side integrations runtime (spec §4.6): durable routine execution
//! bound to Restate in Task 3; the executor and run loop are plain async.

pub mod exec_policy_gate;
pub mod executor;
pub mod funnel;
pub mod mcp_pool;
pub mod overflow;
pub mod restate;
pub mod run;
pub mod spill;
pub mod turn;
