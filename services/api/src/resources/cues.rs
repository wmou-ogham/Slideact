use std::collections::HashSet;

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use slide_helper_domain::normalize_slide_anchor;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState, api_error::ApiError, auth::authenticated_user_id,
    authorization::authorize_presenter_access,
};

use super::{
    interactions::{Interaction, load_interaction},
    persistence_error, require_cue, require_project_access, require_project_write,
};

#[derive(Debug, Serialize)]
pub(super) struct Cue {
    id: Uuid,
    project_id: Uuid,
    pub(super) position: i32,
    pub(super) name: String,
    pub(super) anchor_type: String,
    pub(super) anchor_value: Option<String>,
    pub(super) trigger_mode: String,
    pub(super) delay_seconds: i32,
    pub(super) interactions: Vec<Interaction>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateCueRequest {
    name: String,
    anchor_type: String,
    anchor_value: Option<String>,
    trigger_mode: String,
    delay_seconds: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateCueRequest {
    name: String,
    anchor_type: String,
    anchor_value: Option<String>,
    trigger_mode: String,
    delay_seconds: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReorderCuesRequest {
    cue_ids: Vec<Uuid>,
}

pub(super) async fn list_cues(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<Cue>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_access(&state.database, project_id, user_id).await?;
    Ok(Json(load_cues(&state.database, project_id).await?))
}

pub(super) async fn list_controller_cues(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<Cue>>, ApiError> {
    authorize_presenter_access(&state.database, &headers, session_id).await?;
    let project_id =
        sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM live_sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(&state.database)
            .await
            .map_err(persistence_error)?
            .ok_or_else(|| ApiError::not_found("session_not_found"))?;
    Ok(Json(load_cues(&state.database, project_id).await?))
}

pub(super) async fn create_cue(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateCueRequest>,
) -> Result<(StatusCode, Json<Cue>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    validate_cue(
        &request.name,
        &request.anchor_type,
        request.anchor_value.as_deref(),
        &request.trigger_mode,
        request.delay_seconds,
    )?;
    let position = sqlx::query_scalar::<_, i32>(
        "SELECT COALESCE(MAX(position) + 1, 0)::INTEGER FROM cues WHERE project_id = $1",
    )
    .bind(project_id)
    .fetch_one(&state.database)
    .await
    .map_err(persistence_error)?;
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO cues (id, project_id, position, name, anchor_type, anchor_value, trigger_mode, delay_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(id)
    .bind(project_id)
    .bind(position)
    .bind(request.name.trim())
    .bind(&request.anchor_type)
    .bind(normalize_anchor(&request.anchor_type, request.anchor_value))
    .bind(&request.trigger_mode)
    .bind(request.delay_seconds)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(load_cue(&state.database, id).await?),
    ))
}

pub(super) async fn reorder_cues(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<ReorderCuesRequest>,
) -> Result<Json<Vec<Cue>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    let existing = sqlx::query_as::<_, (Uuid, i32)>(
        "SELECT id, position FROM cues WHERE project_id = $1 ORDER BY position, id",
    )
    .bind(project_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    let requested = request.cue_ids.iter().copied().collect::<HashSet<_>>();
    let expected = existing.iter().map(|row| row.0).collect::<HashSet<_>>();
    if request.cue_ids.len() != requested.len() || requested != expected {
        return Err(ApiError::bad_request("cue_order_invalid"));
    }
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let temporary_start = existing
        .iter()
        .map(|row| row.1)
        .max()
        .unwrap_or(-1)
        .checked_add(1)
        .ok_or_else(|| ApiError::bad_request("cue_order_invalid"))?;
    for (offset, cue_id) in request.cue_ids.iter().copied().enumerate() {
        let temporary_position = temporary_start
            .checked_add(
                i32::try_from(offset).map_err(|_| ApiError::bad_request("cue_order_invalid"))?,
            )
            .ok_or_else(|| ApiError::bad_request("cue_order_invalid"))?;
        sqlx::query("UPDATE cues SET position = $3 WHERE id = $1 AND project_id = $2")
            .bind(cue_id)
            .bind(project_id)
            .bind(temporary_position)
            .execute(&mut *transaction)
            .await
            .map_err(persistence_error)?;
    }
    for (position, cue_id) in request.cue_ids.into_iter().enumerate() {
        sqlx::query(
            "UPDATE cues SET position = $3, updated_at = NOW() WHERE id = $1 AND project_id = $2",
        )
        .bind(cue_id)
        .bind(project_id)
        .bind(i32::try_from(position).map_err(|_| ApiError::bad_request("cue_order_invalid"))?)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;
    }
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(load_cues(&state.database, project_id).await?))
}

pub(super) async fn update_cue(
    State(state): State<AppState>,
    Path((project_id, cue_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<UpdateCueRequest>,
) -> Result<Json<Cue>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    require_cue(&state.database, project_id, cue_id).await?;
    validate_cue(
        &request.name,
        &request.anchor_type,
        request.anchor_value.as_deref(),
        &request.trigger_mode,
        request.delay_seconds,
    )?;
    sqlx::query(
        r#"
        UPDATE cues SET name = $3, anchor_type = $4, anchor_value = $5,
            trigger_mode = $6, delay_seconds = $7, updated_at = NOW()
        WHERE id = $1 AND project_id = $2
        "#,
    )
    .bind(cue_id)
    .bind(project_id)
    .bind(request.name.trim())
    .bind(&request.anchor_type)
    .bind(normalize_anchor(&request.anchor_type, request.anchor_value))
    .bind(&request.trigger_mode)
    .bind(request.delay_seconds)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(Json(load_cue(&state.database, cue_id).await?))
}

pub(super) async fn delete_cue(
    State(state): State<AppState>,
    Path((project_id, cue_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    let affected = sqlx::query("DELETE FROM cues WHERE id = $1 AND project_id = $2")
        .bind(cue_id)
        .bind(project_id)
        .execute(&state.database)
        .await
        .map_err(persistence_error)?
        .rows_affected();
    if affected == 0 {
        return Err(ApiError::not_found("cue_not_found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn load_cues(database: &PgPool, project_id: Uuid) -> Result<Vec<Cue>, ApiError> {
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM cues WHERE project_id = $1 ORDER BY position, id",
    )
    .bind(project_id)
    .fetch_all(database)
    .await
    .map_err(persistence_error)?;
    let mut cues = Vec::with_capacity(ids.len());
    for id in ids {
        cues.push(load_cue(database, id).await?);
    }
    Ok(cues)
}

async fn load_cue(database: &PgPool, cue_id: Uuid) -> Result<Cue, ApiError> {
    let row = sqlx::query_as::<_, (Uuid, Uuid, i32, String, String, Option<String>, String, i32)>(
        r#"
        SELECT id, project_id, position, name, anchor_type, anchor_value, trigger_mode, delay_seconds
        FROM cues WHERE id = $1
        "#,
    )
    .bind(cue_id)
    .fetch_optional(database)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("cue_not_found"))?;
    let interaction_ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM interactions WHERE cue_id = $1 ORDER BY position, id",
    )
    .bind(cue_id)
    .fetch_all(database)
    .await
    .map_err(persistence_error)?;
    let mut interactions = Vec::with_capacity(interaction_ids.len());
    for id in interaction_ids {
        interactions.push(load_interaction(database, id).await?);
    }
    Ok(Cue {
        id: row.0,
        project_id: row.1,
        position: row.2,
        name: row.3,
        anchor_type: row.4,
        anchor_value: row.5,
        trigger_mode: row.6,
        delay_seconds: row.7,
        interactions,
    })
}

fn validate_cue(
    name: &str,
    anchor_type: &str,
    anchor_value: Option<&str>,
    trigger_mode: &str,
    delay_seconds: i32,
) -> Result<(), ApiError> {
    if name.trim().is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad_request("cue_name_invalid"));
    }
    match anchor_type {
        "manual" if anchor_value.is_none_or(|value| value.trim().is_empty()) => {}
        "deck_slide" if anchor_value.is_some_and(|value| !value.trim().is_empty()) => {}
        _ => return Err(ApiError::bad_request("cue_anchor_invalid")),
    }
    match trigger_mode {
        "immediate" | "presenter_confirm" if delay_seconds == 0 => {}
        "delay" if delay_seconds > 0 && delay_seconds <= 3600 => {}
        _ => return Err(ApiError::bad_request("cue_trigger_invalid")),
    }
    Ok(())
}

fn normalize_anchor(anchor_type: &str, value: Option<String>) -> Option<String> {
    if anchor_type == "manual" {
        None
    } else {
        value
            .map(|value| normalize_slide_anchor(&value))
            .filter(|value| !value.is_empty())
    }
}
