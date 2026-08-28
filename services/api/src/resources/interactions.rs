use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState, api_error::ApiError, auth::authenticated_user_id, commands::emit_event_to_all,
};

use super::{persistence_error, require_cue, require_project_write};

#[derive(Debug, Serialize)]
pub(super) struct Interaction {
    id: Uuid,
    cue_id: Uuid,
    pub(super) position: i32,
    pub(super) interaction_type: String,
    pub(super) prompt: String,
    pub(super) description: Option<String>,
    pub(super) settings: Value,
    pub(super) options: Vec<InteractionOption>,
}

#[derive(Debug, Serialize)]
pub(super) struct InteractionOption {
    id: Uuid,
    position: i32,
    pub(super) label: String,
    pub(super) is_correct: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InteractionInput {
    pub(super) interaction_type: String,
    pub(super) prompt: String,
    pub(super) description: Option<String>,
    #[serde(default = "default_settings")]
    pub(super) settings: Value,
    #[serde(default)]
    pub(super) options: Vec<InteractionOptionInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InteractionOptionInput {
    pub(super) label: String,
    pub(super) is_correct: Option<bool>,
}

pub(super) async fn create_interaction(
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
    notify_live_cue_interaction(&mut transaction, project_id, cue_id, id).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(load_interaction(&state.database, id).await?),
    ))
}

pub(super) async fn update_interaction(
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
    notify_live_cue_interaction(&mut transaction, project_id, cue_id, interaction_id).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(
        load_interaction(&state.database, interaction_id).await?,
    ))
}

pub(super) async fn delete_interaction(
    State(state): State<AppState>,
    Path((project_id, cue_id, interaction_id)): Path<(Uuid, Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_project_write(&state.database, project_id, user_id).await?;
    require_cue(&state.database, project_id, cue_id).await?;
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let affected = sqlx::query("DELETE FROM interactions WHERE id = $1 AND cue_id = $2")
        .bind(interaction_id)
        .bind(cue_id)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?
        .rows_affected();
    if affected == 0 {
        return Err(ApiError::not_found("interaction_not_found"));
    }
    notify_live_cue_interaction(&mut transaction, project_id, cue_id, interaction_id).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn insert_interaction(
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

async fn notify_live_cue_interaction(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: Uuid,
    cue_id: Uuid,
    interaction_id: Uuid,
) -> Result<(), ApiError> {
    let rows = sqlx::query_as::<_, (Uuid, i64, Uuid, String)>(
        r#"
        SELECT live_sessions.id, live_sessions.state_version, cue_runs.id, cue_runs.state
        FROM live_sessions
        JOIN cue_runs ON cue_runs.id = live_sessions.current_cue_run_id
        WHERE live_sessions.project_id = $1
          AND cue_runs.cue_id = $2
          AND live_sessions.status IN ('lobby', 'live', 'paused')
        "#,
    )
    .bind(project_id)
    .bind(cue_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    for (session_id, state_version, cue_run_id, state) in rows {
        emit_event_to_all(
            transaction,
            session_id,
            u64::try_from(state_version)
                .map_err(|_| ApiError::internal("state_version_invalid"))?,
            json!({
                "event_type": "interaction.state_changed",
                "cue_run_id": cue_run_id,
                "interaction_id": interaction_id,
                "state": state,
            }),
            &format!("interaction-{interaction_id}-{}", Uuid::new_v4()),
        )
        .await?;
    }
    Ok(())
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

pub(super) async fn load_interaction(
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
    validate_response_settings(&request.settings)?;
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

fn validate_response_settings(settings: &Value) -> Result<(), ApiError> {
    let Some(response) = settings.get("response") else {
        return Ok(());
    };
    let response = response
        .as_object()
        .ok_or_else(|| ApiError::bad_request("interaction_settings_invalid"))?;
    let booleans_valid = ["allow_change", "multiple_selection", "allow_duplicate"]
        .into_iter()
        .all(|key| response.get(key).is_none_or(Value::is_boolean));
    let limit_valid = response.get("submission_limit").is_none_or(|value| {
        value
            .as_u64()
            .is_some_and(|limit| (1..=10).contains(&limit))
    });
    if booleans_valid && limit_valid {
        Ok(())
    } else {
        Err(ApiError::bad_request("interaction_settings_invalid"))
    }
}

fn default_settings() -> Value {
    json!({"schema_version": 1})
}

fn trimmed_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{InteractionInput, validate_interaction, validate_response_settings};

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

    #[test]
    fn response_settings_validate_booleans_and_word_cloud_limits() {
        assert!(
            validate_response_settings(&json!({
                "response": {
                    "allow_change": false,
                    "multiple_selection": true,
                    "submission_limit": 10,
                    "allow_duplicate": false
                }
            }))
            .is_ok()
        );
        assert!(
            validate_response_settings(&json!({
                "response": {"submission_limit": 0}
            }))
            .is_err()
        );
        assert!(
            validate_response_settings(&json!({
                "response": {"allow_change": "yes"}
            }))
            .is_err()
        );
    }
}
