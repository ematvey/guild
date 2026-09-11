//! Server-side integrations runtime (spec §4.6): durable routine execution
//! bound to Restate in Task 3; the executor and run loop are plain async.

pub mod executor;
pub mod mcp_pool;
pub mod overflow;
pub mod restate;
pub mod run;
