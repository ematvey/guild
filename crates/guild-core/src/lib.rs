//! The local tool executor: the builtin tools a machine runs for the
//! durable conversation harness (TS server), their registry, artifact
//! materialization, and the registry bundle codec. Used by the local
//! engine (app-server).

pub mod registry;
pub mod tools;
