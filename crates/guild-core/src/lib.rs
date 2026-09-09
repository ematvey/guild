//! Agent loop, tool definitions, provider client types. Shared by the local
//! app-server (desktop engine) and, later, server-side agent workers.

pub mod agent;
pub mod provider;
pub mod registry;
pub mod tools;
pub mod usage;

pub use provider::{ChatChunk, ModelProvider, ProviderChunk, ProviderError, ProviderRequest};
