//! Org events API: recent events are listed here; live delivery uses the
//! authenticated WebSocket feed in [`crate::http::feed`].

use crate::http::auth::AuthUser;
use crate::http::error::ApiError;
use crate::state::AppState;
use axum::extract::State;
use axum::{Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v1/events", axum::routing::get(list))
}

async fn list(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let store = state.store().await?;
    let events = store.events().list(user.0.org_id, 200).await?;
    Ok(Json(json!({ "events": events })))
}
