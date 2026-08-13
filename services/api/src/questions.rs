use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    auth::authenticated_user_id,
    authorization::{SessionRole, authenticate_session_token, bearer_token, require_session_owner},
    commands::emit_event_to_all,
};

#[derive(Debug, Serialize)]
pub(crate) struct QuestionView {
    id: Uuid,
    cue_run_id: Uuid,
    body: String,
    status: String,
    votes: i64,
    voted_by_me: bool,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateQuestionRequest {
    cue_run_id: Uuid,
    body: String,
}

#[derive(Debug, Serialize)]
struct VoteQuestionResponse {
    voted: bool,
    votes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateQuestionRequest {
    status: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/audience/questions", post(create_question))
        .route(
            "/api/audience/questions/{question_id}/vote",
            post(toggle_question_vote),
        )
        .route(
            "/api/sessions/{session_id}/questions",
            get(list_presenter_questions),
        )
        .route(
            "/api/sessions/{session_id}/questions/{question_id}",
            patch(update_question),
        )
}

async fn create_question(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateQuestionRequest>,
) -> Result<(StatusCode, Json<QuestionView>), ApiError> {
    let body = validate_body(&request.body)?;
    let actor = authenticate_session_token(&state.database, bearer_token(&headers)?).await?;
    if actor.role != SessionRole::Audience {
        return Err(ApiError::forbidden("audience_token_required"));
    }
    let participant_id = actor
        .participant_id
        .ok_or_else(|| ApiError::forbidden("participant_token_required"))?;
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let state_version =
        open_qa_state_version(&mut transaction, actor.session_id, request.cue_run_id).await?;
    let id = Uuid::new_v4();
    let created_at = sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO questions (id, cue_run_id, participant_id, body, status)
        VALUES ($1, $2, $3, $4, 'visible')
        RETURNING created_at::TEXT
        "#,
    )
    .bind(id)
    .bind(request.cue_run_id)
    .bind(participant_id)
    .bind(&body)
    .fetch_one(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    emit_event_to_all(
        &mut transaction,
        actor.session_id,
        state_version,
        json!({"event_type": "question.created", "question_id": id}),
        &format!("question-created-{id}"),
    )
    .await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(QuestionView {
            id,
            cue_run_id: request.cue_run_id,
            body,
            status: "visible".to_owned(),
            votes: 0,
            voted_by_me: false,
            created_at,
        }),
    ))
}

async fn toggle_question_vote(
    State(state): State<AppState>,
    Path(question_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<VoteQuestionResponse>, ApiError> {
    let actor = authenticate_session_token(&state.database, bearer_token(&headers)?).await?;
    if actor.role != SessionRole::Audience {
        return Err(ApiError::forbidden("audience_token_required"));
    }
    let participant_id = actor
        .participant_id
        .ok_or_else(|| ApiError::forbidden("participant_token_required"))?;
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let question = sqlx::query_as::<_, (i64, Uuid)>(
        r#"
        SELECT live_sessions.state_version, questions.cue_run_id
        FROM questions
        JOIN cue_runs ON cue_runs.id = questions.cue_run_id
        JOIN live_sessions ON live_sessions.id = cue_runs.session_id
        WHERE questions.id = $1 AND live_sessions.id = $2
          AND questions.status IN ('visible', 'pinned', 'answered')
        FOR UPDATE OF questions
        "#,
    )
    .bind(question_id)
    .bind(actor.session_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("question_not_found"))?;
    let inserted = sqlx::query(
        "INSERT INTO question_votes (question_id, participant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(question_id)
    .bind(participant_id)
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .rows_affected()
        == 1;
    if !inserted {
        sqlx::query("DELETE FROM question_votes WHERE question_id = $1 AND participant_id = $2")
            .bind(question_id)
            .bind(participant_id)
            .execute(&mut *transaction)
            .await
            .map_err(persistence_error)?;
    }
    let votes =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM question_votes WHERE question_id = $1")
            .bind(question_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(persistence_error)?;
    emit_event_to_all(
        &mut transaction,
        actor.session_id,
        u64::try_from(question.0).map_err(|_| ApiError::internal("state_version_invalid"))?,
        json!({"event_type": "question.votes_updated", "question_id": question_id, "votes": votes}),
        &format!(
            "question-vote-{question_id}-{participant_id}-{}",
            Uuid::new_v4()
        ),
    )
    .await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(VoteQuestionResponse {
        voted: inserted,
        votes,
    }))
}

async fn list_presenter_questions(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<QuestionView>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;
    Ok(Json(
        load_questions(&state.database, session_id, None, true).await?,
    ))
}

async fn update_question(
    State(state): State<AppState>,
    Path((session_id, question_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<UpdateQuestionRequest>,
) -> Result<Json<QuestionView>, ApiError> {
    if !matches!(
        request.status.as_str(),
        "visible" | "answered" | "hidden" | "pinned"
    ) {
        return Err(ApiError::bad_request("question_status_invalid"));
    }
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    if request.status == "pinned" {
        sqlx::query(
            r#"
            UPDATE questions SET status = 'visible', updated_at = NOW()
            WHERE status = 'pinned' AND cue_run_id IN (
                SELECT id FROM cue_runs WHERE session_id = $1
            )
            "#,
        )
        .bind(session_id)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;
    }
    let row = sqlx::query_as::<_, (Uuid, String, String, String)>(
        r#"
        UPDATE questions SET status = $3, updated_at = NOW()
        WHERE id = $2 AND cue_run_id IN (SELECT id FROM cue_runs WHERE session_id = $1)
        RETURNING cue_run_id, body, status, created_at::TEXT
        "#,
    )
    .bind(session_id)
    .bind(question_id)
    .bind(&request.status)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("question_not_found"))?;
    let votes =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM question_votes WHERE question_id = $1")
            .bind(question_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(persistence_error)?;
    let state_version =
        sqlx::query_scalar::<_, i64>("SELECT state_version FROM live_sessions WHERE id = $1")
            .bind(session_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(persistence_error)?;
    emit_event_to_all(
        &mut transaction,
        session_id,
        u64::try_from(state_version).map_err(|_| ApiError::internal("state_version_invalid"))?,
        json!({"event_type": "question.status_updated", "question_id": question_id, "status": request.status}),
        &format!("question-status-{question_id}-{}", Uuid::new_v4()),
    )
    .await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(QuestionView {
        id: question_id,
        cue_run_id: row.0,
        body: row.1,
        status: row.2,
        votes,
        voted_by_me: false,
        created_at: row.3,
    }))
}

pub(crate) async fn load_questions(
    database: &sqlx::PgPool,
    session_id: Uuid,
    participant_id: Option<Uuid>,
    include_hidden: bool,
) -> Result<Vec<QuestionView>, ApiError> {
    sqlx::query_as::<_, (Uuid, Uuid, String, String, i64, bool, String)>(
        r#"
        SELECT questions.id, questions.cue_run_id, questions.body, questions.status,
               COUNT(question_votes.participant_id),
               COALESCE(BOOL_OR(question_votes.participant_id = $2), FALSE),
               questions.created_at::TEXT
        FROM questions
        JOIN cue_runs ON cue_runs.id = questions.cue_run_id
        LEFT JOIN question_votes ON question_votes.question_id = questions.id
        WHERE cue_runs.session_id = $1
          AND cue_runs.id = (SELECT current_cue_run_id FROM live_sessions WHERE id = $1)
          AND ($3 OR questions.status IN ('visible', 'pinned', 'answered'))
        GROUP BY questions.id
        ORDER BY (questions.status = 'pinned') DESC, COUNT(question_votes.participant_id) DESC,
                 questions.created_at ASC
        "#,
    )
    .bind(session_id)
    .bind(participant_id)
    .bind(include_hidden)
    .fetch_all(database)
    .await
    .map_err(persistence_error)
    .map(|rows| {
        rows.into_iter()
            .map(|row| QuestionView {
                id: row.0,
                cue_run_id: row.1,
                body: row.2,
                status: row.3,
                votes: row.4,
                voted_by_me: row.5,
                created_at: row.6,
            })
            .collect()
    })
}

async fn open_qa_state_version(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    cue_run_id: Uuid,
) -> Result<u64, ApiError> {
    let version = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT live_sessions.state_version
        FROM cue_runs
        JOIN live_sessions ON live_sessions.id = cue_runs.session_id
        WHERE cue_runs.id = $1 AND live_sessions.id = $2 AND cue_runs.state = 'open'
          AND EXISTS (
              SELECT 1 FROM interactions
              WHERE interactions.cue_id = cue_runs.cue_id
                AND interactions.interaction_type = 'qa'
          )
        FOR UPDATE OF cue_runs
        "#,
    )
    .bind(cue_run_id)
    .bind(session_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::conflict("qa_not_open"))?;
    u64::try_from(version).map_err(|_| ApiError::internal("state_version_invalid"))
}

fn validate_body(body: &str) -> Result<String, ApiError> {
    let body = body.trim();
    if body.is_empty() || body.chars().count() > 500 {
        return Err(ApiError::bad_request("question_body_invalid"));
    }
    Ok(body.to_owned())
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "question persistence operation failed");
    ApiError::internal("question_persistence_failed")
}
