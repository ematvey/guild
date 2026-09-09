//! Per-request usage records written to ClickHouse (spec §4.5).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEvent {
    pub ts: DateTime<Utc>,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub team_id: Option<Uuid>,
    pub session_id: Uuid,
    pub model: String,
    pub provider: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub cost_usd: f64,
    pub request_id: Uuid,
}

impl UsageEvent {
    /// Cost from org-configured per-model prices (USD per million tokens).
    pub fn cost_usd(tokens_in: u32, tokens_out: u32, price_in: f64, price_out: f64) -> f64 {
        tokens_in as f64 / 1_000_000.0 * price_in + tokens_out as f64 / 1_000_000.0 * price_out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_math() {
        let cost = UsageEvent::cost_usd(1_000_000, 500_000, 2.0, 4.0);
        assert_eq!(cost, 4.0);
    }
}
