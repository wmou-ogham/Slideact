mod events;
mod handlers;
mod snapshot;
mod transitions;

use axum::{
    Router,
    routing::{get, post},
};
use tracing::warn;

use crate::{AppState, api_error::ApiError};

pub(crate) use events::{emit_event_to_all, emit_event_to_topics};
pub(crate) use handlers::apply_follow_position;
pub(crate) use snapshot::{SessionSnapshot, snapshot_for_session};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sessions/{session_id}/commands",
            post(handlers::command),
        )
        .route(
            "/api/sessions/{session_id}/snapshot",
            get(handlers::snapshot),
        )
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(database_error) = &error
        && database_error.is_unique_violation()
    {
        return ApiError::conflict("command_conflict");
    }
    warn!(%error, "command persistence operation failed");
    ApiError::internal("command_persistence_failed")
}
