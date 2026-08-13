use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::warn;
use uuid::Uuid;

use crate::{AppState, api_error::ApiError, auth::authenticated_user_id};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateClientErrorRequest {
    surface: String,
    route: String,
    message: String,
    #[serde(default)]
    context: Value,
}

#[derive(Debug, Serialize)]
struct ClientErrorView {
    id: Uuid,
    surface: String,
    route: String,
    message: String,
    context: Value,
    created_at: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/diagnostics/client-errors",
        post(create_client_error).get(list_client_errors),
    )
}

async fn create_client_error(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateClientErrorRequest>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    validate_request(&request)?;
    sqlx::query(
        r#"
        INSERT INTO client_error_reports (id, user_id, surface, route, message, context)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(&request.surface)
    .bind(request.route.trim())
    .bind(request.message.trim())
    .bind(&request.context)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_client_errors(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ClientErrorView>>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    let rows = sqlx::query_as::<_, (Uuid, String, String, String, Value, String)>(
        r#"
        SELECT id, surface, route, message, context, created_at::TEXT
        FROM client_error_reports WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 50
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok(Json(
        rows.into_iter()
            .map(|row| ClientErrorView {
                id: row.0,
                surface: row.1,
                route: row.2,
                message: row.3,
                context: row.4,
                created_at: row.5,
            })
            .collect(),
    ))
}

fn validate_request(request: &CreateClientErrorRequest) -> Result<(), ApiError> {
    if !matches!(request.surface.as_str(), "web" | "extension")
        || request.route.trim().is_empty()
        || request.route.chars().count() > 300
        || request.message.trim().is_empty()
        || request.message.chars().count() > 500
        || !request.context.is_object()
        || request.context.to_string().len() > 2_000
    {
        return Err(ApiError::bad_request("client_error_invalid"));
    }
    Ok(())
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "client error report persistence operation failed");
    ApiError::internal("diagnostics_persistence_failed")
}
