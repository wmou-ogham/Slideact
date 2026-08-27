mod cues;
mod interactions;
mod projects;
mod sessions;

use axum::{
    Router,
    routing::{get, post, put},
};
use sqlx::PgPool;
use tracing::warn;
use uuid::Uuid;

use crate::{AppState, api_error::ApiError};

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

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects",
            get(projects::list_projects).post(projects::create_project),
        )
        .route(
            "/api/projects/{project_id}",
            get(projects::get_project)
                .put(projects::update_project)
                .delete(projects::delete_project),
        )
        .route(
            "/api/projects/{project_id}/archive",
            post(projects::archive_project),
        )
        .route(
            "/api/projects/{project_id}/duplicate",
            post(projects::duplicate_project),
        )
        .route(
            "/api/projects/{project_id}/cues",
            get(cues::list_cues).post(cues::create_cue),
        )
        .route(
            "/api/projects/{project_id}/cues/reorder",
            put(cues::reorder_cues),
        )
        .route(
            "/api/projects/{project_id}/cues/{cue_id}",
            put(cues::update_cue).delete(cues::delete_cue),
        )
        .route(
            "/api/projects/{project_id}/cues/{cue_id}/interactions",
            post(interactions::create_interaction),
        )
        .route(
            "/api/projects/{project_id}/cues/{cue_id}/interactions/{interaction_id}",
            put(interactions::update_interaction).delete(interactions::delete_interaction),
        )
        .route(
            "/api/projects/{project_id}/sessions",
            get(sessions::list_sessions).post(sessions::create_session),
        )
        .route(
            "/api/sessions/{session_id}/controller-cues",
            get(cues::list_controller_cues),
        )
        .route("/api/sessions/{session_id}", get(sessions::get_session))
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

fn validate_locale(locale: &str) -> Result<(), ApiError> {
    if matches!(locale, "en" | "zh-TW") {
        Ok(())
    } else {
        Err(ApiError::bad_request("locale_invalid"))
    }
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
