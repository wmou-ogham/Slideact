use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{AppState, api_error::ApiError, auth::authenticated_user_id};

use super::{persistence_error, require_project_access, require_project_write, validate_locale};

#[derive(Debug, Serialize)]
pub(super) struct LiveSession {
    id: Uuid,
    project_id: Uuid,
    join_code: Option<String>,
    status: String,
    locale: String,
    sync_mode: String,
    interface_theme: String,
    presentation_follows_cue: bool,
    state_version: i64,
    created_at: String,
    started_at: Option<String>,
    ended_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateLiveSessionRequest {
    locale: String,
    #[serde(default = "default_interface_theme")]
    interface_theme: String,
}

fn default_interface_theme() -> String {
    "lively".to_owned()
}

pub(super) async fn list_sessions(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<LiveSession>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_access(&state.database, project_id, user_id).await?;
    let rows = sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT id, project_id, RTRIM(join_code), status, locale, sync_mode, interface_theme,
               presentation_follows_cue, state_version, created_at::TEXT, started_at::TEXT, ended_at::TEXT
        FROM live_sessions WHERE project_id = $1 ORDER BY created_at DESC
        "#,
    )
    .bind(project_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(Json(rows.into_iter().map(session_from_row).collect()))
}

pub(super) async fn create_session(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateLiveSessionRequest>,
) -> Result<(StatusCode, Json<LiveSession>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    validate_locale(&request.locale)?;
    validate_interface_theme(&request.interface_theme)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO live_sessions (id, project_id, locale, interface_theme) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(project_id)
        .bind(&request.locale)
        .bind(&request.interface_theme)
        .execute(&state.database)
        .await
        .map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(load_session(&state.database, id).await?),
    ))
}

pub(super) async fn get_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<LiveSession>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    let project_id =
        sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM live_sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(&state.database)
            .await
            .map_err(persistence_error)?
            .ok_or_else(|| ApiError::not_found("session_not_found"))?;
    require_project_access(&state.database, project_id, user_id).await?;
    Ok(Json(load_session(&state.database, session_id).await?))
}

async fn load_session(database: &PgPool, session_id: Uuid) -> Result<LiveSession, ApiError> {
    sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT id, project_id, RTRIM(join_code), status, locale, sync_mode, interface_theme,
               presentation_follows_cue, state_version, created_at::TEXT, started_at::TEXT, ended_at::TEXT
        FROM live_sessions WHERE id = $1
        "#,
    )
    .bind(session_id)
    .fetch_optional(database)
    .await
    .map_err(persistence_error)?
    .map(session_from_row)
    .ok_or_else(|| ApiError::not_found("session_not_found"))
}

type SessionRow = (
    Uuid,
    Uuid,
    Option<String>,
    String,
    String,
    String,
    String,
    bool,
    i64,
    String,
    Option<String>,
    Option<String>,
);

fn session_from_row(row: SessionRow) -> LiveSession {
    LiveSession {
        id: row.0,
        project_id: row.1,
        join_code: row.2,
        status: row.3,
        locale: row.4,
        sync_mode: row.5,
        interface_theme: row.6,
        presentation_follows_cue: row.7,
        state_version: row.8,
        created_at: row.9,
        started_at: row.10,
        ended_at: row.11,
    }
}

fn validate_interface_theme(theme: &str) -> Result<(), ApiError> {
    if matches!(theme, "classic" | "lively" | "terminal") {
        Ok(())
    } else {
        Err(ApiError::bad_request("interface_theme_invalid"))
    }
}
