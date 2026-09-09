//! Shared protocol types: local JSON-RPC (UI <-> app-server) and cloud API
//! schemas (app-server <-> guild-server). Versioned from day one; every
//! JSON-RPC envelope carries `protocol: PROTOCOL_VERSION`.

pub mod api;
pub mod rpc;
