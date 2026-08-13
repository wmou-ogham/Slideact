use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
};
use serde::Serialize;
use serde_json::Value;
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    authorization::{SessionRole, authenticate_session_token, bearer_token},
    commands::{SessionSnapshot, snapshot_for_session},
    questions::{QuestionView, load_questions},
};

#[derive(Debug, Serialize)]
struct LiveView {
    snapshot: SessionSnapshot,
    audience_count: i64,
    aggregates: Vec<AggregateView>,
    questions: Vec<QuestionView>,
}

#[derive(Debug, Serialize)]
struct AggregateView {
    cue_run_id: Uuid,
    interaction_id: Uuid,
    aggregate: Value,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/live/sessions/{session_id}", get(get_live_view))
}

async fn get_live_view(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<LiveView>, ApiError> {
    let actor = authenticate_session_token(&state.database, bearer_token(&headers)?).await?;
    if actor.session_id != session_id {
        return Err(ApiError::not_found("session_not_found"));
    }

    let mut snapshot = snapshot_for_session(&state.database, session_id).await?;
    if matches!(actor.role, SessionRole::Audience | SessionRole::Overlay) {
        snapshot = snapshot.redact_for_audience();
    }
    let audience_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM participants WHERE session_id = $1")
            .bind(session_id)
            .fetch_one(&state.database)
            .await
            .map_err(persistence_error)?;
    let aggregates = sqlx::query_as::<_, (Uuid, Uuid, Value)>(
        r#"
        SELECT response_aggregates.cue_run_id,
               response_aggregates.interaction_id,
               response_aggregates.aggregate
        FROM response_aggregates
        JOIN cue_runs ON cue_runs.id = response_aggregates.cue_run_id
        WHERE cue_runs.session_id = $1
          AND cue_runs.id = (
              SELECT current_cue_run_id FROM live_sessions WHERE id = $1
          )
        ORDER BY response_aggregates.interaction_id
        "#,
    )
    .bind(session_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?
    .into_iter()
    .map(|row| AggregateView {
        cue_run_id: row.0,
        interaction_id: row.1,
        aggregate: row.2,
    })
    .collect();
    let questions = load_questions(
        &state.database,
        session_id,
        actor.participant_id,
        matches!(
            actor.role,
            SessionRole::Owner | SessionRole::Presenter | SessionRole::Controller
        ),
    )
    .await?;

    Ok(Json(LiveView {
        snapshot,
        audience_count,
        aggregates,
        questions,
    }))
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "live view persistence operation failed");
    ApiError::internal("live_view_failed")
}
