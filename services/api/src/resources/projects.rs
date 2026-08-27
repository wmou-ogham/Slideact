use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{AppState, api_error::ApiError, auth::authenticated_user_id};

use super::{
    ProjectAccess,
    cues::load_cues,
    interactions::{InteractionInput, InteractionOptionInput, insert_interaction},
    persistence_error, require_project_access, require_project_write, validate_locale,
};

#[derive(Debug, Serialize)]
pub(super) struct Project {
    id: Uuid,
    pub(super) title: String,
    status: String,
    pub(super) default_locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateProjectRequest {
    title: String,
    default_locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateProjectRequest {
    title: String,
    status: String,
    default_locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DuplicateProjectRequest {
    title: Option<String>,
}

pub(super) async fn list_projects(
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

pub(super) async fn create_project(
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

pub(super) async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Project>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_access(&state.database, project_id, user_id).await?;
    Ok(Json(load_project(&state.database, project_id).await?))
}

pub(super) async fn update_project(
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

pub(super) async fn archive_project(
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

pub(super) async fn delete_project(
    State(state): State<AppState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    let access = require_project_access(&state.database, project_id, user_id).await?;
    if access != ProjectAccess::Owner {
        return Err(ApiError::forbidden("project_owner_required"));
    }

    // Live sessions are the durable activity history. Keep those projects
    // recoverable so deleting a presentation can never delete audience data.
    let has_history = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM live_sessions WHERE project_id = $1)",
    )
    .bind(project_id)
    .fetch_one(&state.database)
    .await
    .map_err(persistence_error)?;
    if has_history {
        return Err(ApiError::conflict("project_has_history"));
    }

    sqlx::query("DELETE FROM projects WHERE id = $1")
        .bind(project_id)
        .execute(&state.database)
        .await
        .map_err(persistence_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn duplicate_project(
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

fn validate_title(title: &str) -> Result<(), ApiError> {
    if title.trim().is_empty() || title.chars().count() > 200 {
        return Err(ApiError::bad_request("project_title_invalid"));
    }
    Ok(())
}
