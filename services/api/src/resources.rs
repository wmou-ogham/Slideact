use std::collections::HashSet;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState, api_error::ApiError, auth::authenticated_user_id,
    authorization::authorize_presenter_access,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectAccess {
    Owner,
    Editor,
    Presenter,
}

impl ProjectAccess {
    const fn may_write(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }
}

#[derive(Debug, Serialize)]
struct Project {
    id: Uuid,
    title: String,
    status: String,
    default_locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateProjectRequest {
    title: String,
    default_locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateProjectRequest {
    title: String,
    status: String,
    default_locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateProjectRequest {
    title: Option<String>,
}

#[derive(Debug, Serialize)]
struct Cue {
    id: Uuid,
    project_id: Uuid,
    position: i32,
    name: String,
    anchor_type: String,
    anchor_value: Option<String>,
    trigger_mode: String,
    delay_seconds: i32,
    interactions: Vec<Interaction>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateCueRequest {
    name: String,
    anchor_type: String,
    anchor_value: Option<String>,
    trigger_mode: String,
    delay_seconds: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateCueRequest {
    name: String,
    anchor_type: String,
    anchor_value: Option<String>,
    trigger_mode: String,
    delay_seconds: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReorderCuesRequest {
    cue_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
struct Interaction {
    id: Uuid,
    cue_id: Uuid,
    position: i32,
    interaction_type: String,
    prompt: String,
    description: Option<String>,
    settings: Value,
    options: Vec<InteractionOption>,
}

#[derive(Debug, Serialize)]
struct InteractionOption {
    id: Uuid,
    position: i32,
    label: String,
    is_correct: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InteractionInput {
    interaction_type: String,
    prompt: String,
    description: Option<String>,
    #[serde(default = "default_settings")]
    settings: Value,
    #[serde(default)]
    options: Vec<InteractionOptionInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InteractionOptionInput {
    label: String,
    is_correct: Option<bool>,
}

#[derive(Debug, Serialize)]
struct LiveSession {
    id: Uuid,
    project_id: Uuid,
    join_code: Option<String>,
    status: String,
    locale: String,
    sync_mode: String,
    state_version: i64,
    created_at: String,
    started_at: Option<String>,
    ended_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateLiveSessionRequest {
    locale: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/{project_id}",
            get(get_project).put(update_project).delete(archive_project),
        )
        .route(
            "/api/projects/{project_id}/duplicate",
            post(duplicate_project),
        )
        .route(
            "/api/projects/{project_id}/cues",
            get(list_cues).post(create_cue),
        )
        .route("/api/projects/{project_id}/cues/reorder", put(reorder_cues))
        .route(
            "/api/projects/{project_id}/cues/{cue_id}",
            put(update_cue).delete(delete_cue),
        )
        .route(
            "/api/projects/{project_id}/cues/{cue_id}/interactions",
            post(create_interaction),
        )
        .route(
            "/api/projects/{project_id}/cues/{cue_id}/interactions/{interaction_id}",
            put(update_interaction).delete(delete_interaction),
        )
        .route(
            "/api/projects/{project_id}/sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/api/sessions/{session_id}/controller-cues",
            get(list_controller_cues),
        )
        .route("/api/sessions/{session_id}", get(get_session))
}

async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Project>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    let rows = sqlx::query_as::<_, (Uuid, String, String, String)>(
        r#"
        SELECT DISTINCT projects.id, projects.title, projects.status, projects.default_locale
        FROM projects
        LEFT JOIN project_members ON project_members.project_id = projects.id
        WHERE projects.owner_id = $1 OR project_members.user_id = $1
        ORDER BY projects.title, projects.id
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(Json(rows.into_iter().map(project_from_row).collect()))
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateProjectRequest>,
) -> Result<(StatusCode, Json<Project>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    validate_title(&request.title)?;
    validate_locale(&request.default_locale)?;
    let id = Uuid::new_v4();
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    sqlx::query(
        "INSERT INTO projects (id, owner_id, title, default_locale) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(user_id)
    .bind(request.title.trim())
    .bind(&request.default_locale)
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    sqlx::query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(Project {
            id,
            title: request.title.trim().to_owned(),
            status: "draft".to_owned(),
            default_locale: request.default_locale,
        }),
    ))
}

async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Project>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_access(&state.database, project_id, user_id).await?;
    Ok(Json(load_project(&state.database, project_id).await?))
}

async fn update_project(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<UpdateProjectRequest>,
) -> Result<Json<Project>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    validate_title(&request.title)?;
    validate_locale(&request.default_locale)?;
    if !matches!(request.status.as_str(), "draft" | "active") {
        return Err(ApiError::bad_request("project_status_invalid"));
    }
    sqlx::query(
        r#"
        UPDATE projects
        SET title = $2, status = $3, default_locale = $4, archived_at = NULL, updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(project_id)
    .bind(request.title.trim())
    .bind(&request.status)
    .bind(&request.default_locale)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(Json(load_project(&state.database, project_id).await?))
}

async fn archive_project(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    let access = require_project_access(&state.database, project_id, user_id).await?;
    if access != ProjectAccess::Owner {
        return Err(ApiError::forbidden("project_owner_required"));
    }
    sqlx::query(
        "UPDATE projects SET status = 'archived', archived_at = NOW(), updated_at = NOW() WHERE id = $1",
    )
    .bind(project_id)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn duplicate_project(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<DuplicateProjectRequest>,
) -> Result<(StatusCode, Json<Project>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_access(&state.database, project_id, user_id).await?;
    let source = load_project(&state.database, project_id).await?;
    let source_cues = load_cues(&state.database, project_id).await?;
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{} (copy)", source.title));
    validate_title(&title)?;

    let duplicate_id = Uuid::new_v4();
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    sqlx::query(
        "INSERT INTO projects (id, owner_id, title, default_locale) VALUES ($1, $2, $3, $4)",
    )
    .bind(duplicate_id)
    .bind(user_id)
    .bind(&title)
    .bind(&source.default_locale)
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    sqlx::query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(duplicate_id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;

    for cue in source_cues {
        let duplicate_cue_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO cues (
                id, project_id, position, name, anchor_type, anchor_value,
                trigger_mode, delay_seconds
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(duplicate_cue_id)
        .bind(duplicate_id)
        .bind(cue.position)
        .bind(cue.name)
        .bind(cue.anchor_type)
        .bind(cue.anchor_value)
        .bind(cue.trigger_mode)
        .bind(cue.delay_seconds)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;

        for interaction in cue.interactions {
            let input = InteractionInput {
                interaction_type: interaction.interaction_type,
                prompt: interaction.prompt,
                description: interaction.description,
                settings: interaction.settings,
                options: interaction
                    .options
                    .into_iter()
                    .map(|option| InteractionOptionInput {
                        label: option.label,
                        is_correct: option.is_correct,
                    })
                    .collect(),
            };
            insert_interaction(
                &mut transaction,
                Uuid::new_v4(),
                duplicate_cue_id,
                interaction.position,
                &input,
            )
            .await?;
        }
    }

    transaction.commit().await.map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(Project {
            id: duplicate_id,
            title,
            status: "draft".to_owned(),
            default_locale: source.default_locale,
        }),
    ))
}

async fn list_cues(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<Cue>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_access(&state.database, project_id, user_id).await?;
    Ok(Json(load_cues(&state.database, project_id).await?))
}

async fn list_controller_cues(
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

async fn create_cue(
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

async fn reorder_cues(
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

async fn update_cue(
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

async fn delete_cue(
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

async fn create_interaction(
    State(state): State<AppState>,
    Path((project_id, cue_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<InteractionInput>,
) -> Result<(StatusCode, Json<Interaction>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    require_cue(&state.database, project_id, cue_id).await?;
    validate_interaction(&request)?;
    let position = sqlx::query_scalar::<_, i32>(
        "SELECT COALESCE(MAX(position) + 1, 0)::INTEGER FROM interactions WHERE cue_id = $1",
    )
    .bind(cue_id)
    .fetch_one(&state.database)
    .await
    .map_err(persistence_error)?;
    let id = Uuid::new_v4();
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    insert_interaction(&mut transaction, id, cue_id, position, &request).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(load_interaction(&state.database, id).await?),
    ))
}

async fn update_interaction(
    State(state): State<AppState>,
    Path((project_id, cue_id, interaction_id)): Path<(Uuid, Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<InteractionInput>,
) -> Result<Json<Interaction>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    require_interaction(&state.database, project_id, cue_id, interaction_id).await?;
    validate_interaction(&request)?;
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    sqlx::query(
        r#"
        UPDATE interactions SET interaction_type = $2, prompt = $3, description = $4,
            settings = $5, updated_at = NOW() WHERE id = $1
        "#,
    )
    .bind(interaction_id)
    .bind(&request.interaction_type)
    .bind(request.prompt.trim())
    .bind(trimmed_optional(request.description.as_deref()))
    .bind(&request.settings)
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    sqlx::query("DELETE FROM interaction_options WHERE interaction_id = $1")
        .bind(interaction_id)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;
    insert_options(&mut transaction, interaction_id, &request.options).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(
        load_interaction(&state.database, interaction_id).await?,
    ))
}

async fn delete_interaction(
    State(state): State<AppState>,
    Path((project_id, cue_id, interaction_id)): Path<(Uuid, Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    require_cue(&state.database, project_id, cue_id).await?;
    let affected = sqlx::query("DELETE FROM interactions WHERE id = $1 AND cue_id = $2")
        .bind(interaction_id)
        .bind(cue_id)
        .execute(&state.database)
        .await
        .map_err(persistence_error)?
        .rows_affected();
    if affected == 0 {
        return Err(ApiError::not_found("interaction_not_found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_sessions(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<LiveSession>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_access(&state.database, project_id, user_id).await?;
    let rows = sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT id, project_id, RTRIM(join_code), status, locale, sync_mode, state_version,
               created_at::TEXT, started_at::TEXT, ended_at::TEXT
        FROM live_sessions WHERE project_id = $1 ORDER BY created_at DESC
        "#,
    )
    .bind(project_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(Json(rows.into_iter().map(session_from_row).collect()))
}

async fn create_session(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateLiveSessionRequest>,
) -> Result<(StatusCode, Json<LiveSession>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    validate_locale(&request.locale)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO live_sessions (id, project_id, locale) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(project_id)
        .bind(&request.locale)
        .execute(&state.database)
        .await
        .map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(load_session(&state.database, id).await?),
    ))
}

async fn get_session(
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

async fn insert_interaction(
    transaction: &mut Transaction<'_, Postgres>,
    id: Uuid,
    cue_id: Uuid,
    position: i32,
    request: &InteractionInput,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO interactions (id, cue_id, position, interaction_type, prompt, description, settings)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(id)
    .bind(cue_id)
    .bind(position)
    .bind(&request.interaction_type)
    .bind(request.prompt.trim())
    .bind(trimmed_optional(request.description.as_deref()))
    .bind(&request.settings)
    .execute(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    insert_options(transaction, id, &request.options).await
}

async fn insert_options(
    transaction: &mut Transaction<'_, Postgres>,
    interaction_id: Uuid,
    options: &[InteractionOptionInput],
) -> Result<(), ApiError> {
    for (position, option) in options.iter().enumerate() {
        sqlx::query(
            r#"
            INSERT INTO interaction_options (id, interaction_id, position, label, is_correct)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(interaction_id)
        .bind(i32::try_from(position).expect("validated option count fits i32"))
        .bind(option.label.trim())
        .bind(option.is_correct)
        .execute(&mut **transaction)
        .await
        .map_err(persistence_error)?;
    }
    Ok(())
}

async fn load_project(database: &PgPool, project_id: Uuid) -> Result<Project, ApiError> {
    sqlx::query_as::<_, (Uuid, String, String, String)>(
        "SELECT id, title, status, default_locale FROM projects WHERE id = $1",
    )
    .bind(project_id)
    .fetch_optional(database)
    .await
    .map_err(persistence_error)?
    .map(project_from_row)
    .ok_or_else(|| ApiError::not_found("project_not_found"))
}

fn project_from_row(row: (Uuid, String, String, String)) -> Project {
    Project {
        id: row.0,
        title: row.1,
        status: row.2,
        default_locale: row.3,
    }
}

async fn load_cues(database: &PgPool, project_id: Uuid) -> Result<Vec<Cue>, ApiError> {
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

async fn load_interaction(
    database: &PgPool,
    interaction_id: Uuid,
) -> Result<Interaction, ApiError> {
    let row = sqlx::query_as::<_, (Uuid, Uuid, i32, String, String, Option<String>, Value)>(
        r#"
        SELECT id, cue_id, position, interaction_type, prompt, description, settings
        FROM interactions WHERE id = $1
        "#,
    )
    .bind(interaction_id)
    .fetch_optional(database)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("interaction_not_found"))?;
    let option_rows = sqlx::query_as::<_, (Uuid, i32, String, Option<bool>)>(
        r#"
        SELECT id, position, label, is_correct FROM interaction_options
        WHERE interaction_id = $1 ORDER BY position, id
        "#,
    )
    .bind(interaction_id)
    .fetch_all(database)
    .await
    .map_err(persistence_error)?;
    Ok(Interaction {
        id: row.0,
        cue_id: row.1,
        position: row.2,
        interaction_type: row.3,
        prompt: row.4,
        description: row.5,
        settings: row.6,
        options: option_rows
            .into_iter()
            .map(|option| InteractionOption {
                id: option.0,
                position: option.1,
                label: option.2,
                is_correct: option.3,
            })
            .collect(),
    })
}

async fn load_session(database: &PgPool, session_id: Uuid) -> Result<LiveSession, ApiError> {
    sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT id, project_id, RTRIM(join_code), status, locale, sync_mode, state_version,
               created_at::TEXT, started_at::TEXT, ended_at::TEXT
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
        state_version: row.6,
        created_at: row.7,
        started_at: row.8,
        ended_at: row.9,
    }
}

async fn require_project_access(
    database: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<ProjectAccess, ApiError> {
    let role = sqlx::query_scalar::<_, String>(
        r#"
        SELECT CASE WHEN projects.owner_id = $2 THEN 'owner' ELSE project_members.role END
        FROM projects
        LEFT JOIN project_members ON project_members.project_id = projects.id AND project_members.user_id = $2
        WHERE projects.id = $1 AND (projects.owner_id = $2 OR project_members.user_id IS NOT NULL)
        "#,
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(database)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("project_not_found"))?;
    match role.as_str() {
        "owner" => Ok(ProjectAccess::Owner),
        "editor" => Ok(ProjectAccess::Editor),
        "presenter" => Ok(ProjectAccess::Presenter),
        _ => Err(ApiError::forbidden("project_access_forbidden")),
    }
}

async fn require_project_write(
    database: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    if require_project_access(database, project_id, user_id)
        .await?
        .may_write()
    {
        Ok(())
    } else {
        Err(ApiError::forbidden("project_write_forbidden"))
    }
}

async fn require_cue(database: &PgPool, project_id: Uuid, cue_id: Uuid) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM cues WHERE id = $1 AND project_id = $2)",
    )
    .bind(cue_id)
    .bind(project_id)
    .fetch_one(database)
    .await
    .map_err(persistence_error)?;
    if exists {
        Ok(())
    } else {
        Err(ApiError::not_found("cue_not_found"))
    }
}

async fn require_interaction(
    database: &PgPool,
    project_id: Uuid,
    cue_id: Uuid,
    interaction_id: Uuid,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM interactions JOIN cues ON cues.id = interactions.cue_id
            WHERE interactions.id = $1 AND cues.id = $2 AND cues.project_id = $3
        )
        "#,
    )
    .bind(interaction_id)
    .bind(cue_id)
    .bind(project_id)
    .fetch_one(database)
    .await
    .map_err(persistence_error)?;
    if exists {
        Ok(())
    } else {
        Err(ApiError::not_found("interaction_not_found"))
    }
}

fn validate_title(title: &str) -> Result<(), ApiError> {
    if title.trim().is_empty() || title.chars().count() > 200 {
        return Err(ApiError::bad_request("project_title_invalid"));
    }
    Ok(())
}

fn validate_locale(locale: &str) -> Result<(), ApiError> {
    if matches!(locale, "en" | "zh-TW") {
        Ok(())
    } else {
        Err(ApiError::bad_request("locale_invalid"))
    }
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

fn validate_interaction(request: &InteractionInput) -> Result<(), ApiError> {
    if request.prompt.trim().is_empty() || request.prompt.chars().count() > 500 {
        return Err(ApiError::bad_request("interaction_prompt_invalid"));
    }
    if !request.settings.is_object()
        || request
            .settings
            .get("schema_version")
            .and_then(Value::as_u64)
            != Some(1)
    {
        return Err(ApiError::bad_request("interaction_settings_invalid"));
    }
    let option_count_valid = match request.interaction_type.as_str() {
        "single_choice" => (2..=6).contains(&request.options.len()),
        "understanding" | "word_cloud" | "qa" => request.options.is_empty(),
        _ => return Err(ApiError::bad_request("interaction_type_invalid")),
    };
    if !option_count_valid
        || request
            .options
            .iter()
            .any(|option| option.label.trim().is_empty() || option.label.chars().count() > 200)
    {
        return Err(ApiError::bad_request("interaction_options_invalid"));
    }
    Ok(())
}

fn normalize_anchor(anchor_type: &str, value: Option<String>) -> Option<String> {
    if anchor_type == "manual" {
        None
    } else {
        value.map(|value| value.trim().to_owned())
    }
}

fn trimmed_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn default_settings() -> Value {
    json!({"schema_version": 1})
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(database_error) = &error
        && (database_error.is_unique_violation() || database_error.is_foreign_key_violation())
    {
        return ApiError::conflict("resource_conflict");
    }
    warn!(%error, "resource persistence operation failed");
    ApiError::internal("resource_persistence_failed")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{InteractionInput, validate_interaction};

    #[test]
    fn single_choice_requires_two_to_six_options() {
        let request = serde_json::from_value::<InteractionInput>(json!({
            "interaction_type": "single_choice",
            "prompt": "Choose",
            "options": [{"label": "Only", "is_correct": true}]
        }))
        .unwrap();
        assert!(validate_interaction(&request).is_err());
    }

    #[test]
    fn understanding_rejects_custom_options() {
        let request = serde_json::from_value::<InteractionInput>(json!({
            "interaction_type": "understanding",
            "prompt": "Understand?",
            "options": [{"label": "Yes", "is_correct": null}]
        }))
        .unwrap();
        assert!(validate_interaction(&request).is_err());
    }
}
