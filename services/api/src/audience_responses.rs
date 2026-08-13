use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    routing::post,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{Postgres, Transaction};
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    authorization::{SessionRole, authenticate_session_token},
    commands::emit_event_to_all,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitResponseRequest {
    cue_run_id: Uuid,
    idempotency_key: String,
    payload: Value,
}

#[derive(Debug, Serialize)]
struct SubmitResponseResponse {
    accepted: bool,
    idempotent: bool,
    aggregate: Value,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/audience/interactions/{interaction_id}/responses",
        post(submit_response),
    )
}

async fn submit_response(
    State(state): State<AppState>,
    Path(interaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<SubmitResponseRequest>,
) -> Result<(StatusCode, Json<SubmitResponseResponse>), ApiError> {
    validate_idempotency_key(&request.idempotency_key)?;
    let token = bearer_token(&headers)?;
    let actor = authenticate_session_token(&state.database, token).await?;
    if actor.role != SessionRole::Audience {
        return Err(ApiError::forbidden("audience_token_required"));
    }
    let participant_id = actor
        .participant_id
        .ok_or_else(|| ApiError::forbidden("participant_token_required"))?;

    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let interaction = sqlx::query_as::<_, (String, String, i64)>(
        r#"
        SELECT interactions.interaction_type, cue_runs.state, live_sessions.state_version
        FROM interactions
        JOIN cues ON cues.id = interactions.cue_id
        JOIN cue_runs ON cue_runs.cue_id = cues.id
        JOIN live_sessions ON live_sessions.id = cue_runs.session_id
        WHERE interactions.id = $1
          AND cue_runs.id = $2
          AND live_sessions.id = $3
        FOR UPDATE OF cue_runs
        "#,
    )
    .bind(interaction_id)
    .bind(request.cue_run_id)
    .bind(actor.session_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("interaction_not_found"))?;
    if interaction.1 != "open" {
        return Err(ApiError::conflict("interaction_not_open"));
    }
    validate_payload(
        &mut transaction,
        interaction_id,
        &interaction.0,
        &request.payload,
    )
    .await?;

    let idempotent = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM responses
            WHERE cue_run_id = $1 AND interaction_id = $2
              AND participant_id = $3 AND idempotency_key = $4
        )
        "#,
    )
    .bind(request.cue_run_id)
    .bind(interaction_id)
    .bind(participant_id)
    .bind(&request.idempotency_key)
    .fetch_one(&mut *transaction)
    .await
    .map_err(persistence_error)?;

    let aggregate = if idempotent {
        load_aggregate(&mut transaction, request.cue_run_id, interaction_id).await?
    } else {
        sqlx::query(
            r#"
            INSERT INTO responses (
                id, cue_run_id, interaction_id, participant_id,
                submission_index, idempotency_key, payload
            )
            VALUES ($1, $2, $3, $4, 0, $5, $6)
            ON CONFLICT (cue_run_id, interaction_id, participant_id, submission_index)
            DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key,
                          payload = EXCLUDED.payload,
                          updated_at = NOW()
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(request.cue_run_id)
        .bind(interaction_id)
        .bind(participant_id)
        .bind(&request.idempotency_key)
        .bind(&request.payload)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;
        let aggregate = compute_aggregate(
            &mut transaction,
            request.cue_run_id,
            interaction_id,
            &interaction.0,
        )
        .await?;
        sqlx::query(
            r#"
            INSERT INTO response_aggregates (cue_run_id, interaction_id, aggregate, version)
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (cue_run_id, interaction_id)
            DO UPDATE SET aggregate = EXCLUDED.aggregate,
                          version = response_aggregates.version + 1,
                          updated_at = NOW()
            "#,
        )
        .bind(request.cue_run_id)
        .bind(interaction_id)
        .bind(&aggregate)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;
        emit_event_to_all(
            &mut transaction,
            actor.session_id,
            u64::try_from(interaction.2)
                .map_err(|_| ApiError::internal("state_version_invalid"))?,
            json!({
                "event_type": "response.aggregate_updated",
                "cue_run_id": request.cue_run_id,
                "interaction_id": interaction_id,
                "aggregate": aggregate,
            }),
            &format!("response-{}-{}", participant_id, request.idempotency_key),
        )
        .await?;
        aggregate
    };
    transaction.commit().await.map_err(persistence_error)?;
    Ok((
        if idempotent {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(SubmitResponseResponse {
            accepted: true,
            idempotent,
            aggregate,
        }),
    ))
}

async fn validate_payload(
    transaction: &mut Transaction<'_, Postgres>,
    interaction_id: Uuid,
    interaction_type: &str,
    payload: &Value,
) -> Result<(), ApiError> {
    let object = single_field_object(payload)?;
    match interaction_type {
        "understanding" => {
            if !object.get("understood").is_some_and(Value::is_boolean) {
                return Err(ApiError::bad_request("response_payload_invalid"));
            }
        }
        "single_choice" => {
            let option_id = object
                .get("option_id")
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| ApiError::bad_request("response_payload_invalid"))?;
            let exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM interaction_options WHERE id = $1 AND interaction_id = $2)",
            )
            .bind(option_id)
            .bind(interaction_id)
            .fetch_one(&mut **transaction)
            .await
            .map_err(persistence_error)?;
            if !exists {
                return Err(ApiError::bad_request("response_option_invalid"));
            }
        }
        _ => return Err(ApiError::bad_request("interaction_type_not_supported")),
    }
    Ok(())
}

fn single_field_object(payload: &Value) -> Result<&Map<String, Value>, ApiError> {
    let object = payload
        .as_object()
        .ok_or_else(|| ApiError::bad_request("response_payload_invalid"))?;
    if object.len() != 1 {
        return Err(ApiError::bad_request("response_payload_invalid"));
    }
    Ok(object)
}

async fn compute_aggregate(
    transaction: &mut Transaction<'_, Postgres>,
    cue_run_id: Uuid,
    interaction_id: Uuid,
    interaction_type: &str,
) -> Result<Value, ApiError> {
    match interaction_type {
        "understanding" => {
            let counts = sqlx::query_as::<_, (i64, i64)>(
                r#"
                SELECT COUNT(*), COUNT(*) FILTER (WHERE payload ->> 'understood' = 'true')
                FROM responses WHERE cue_run_id = $1 AND interaction_id = $2
                "#,
            )
            .bind(cue_run_id)
            .bind(interaction_id)
            .fetch_one(&mut **transaction)
            .await
            .map_err(persistence_error)?;
            let understood_percent = if counts.0 == 0 {
                0.0
            } else {
                counts.1 as f64 * 100.0 / counts.0 as f64
            };
            Ok(json!({
                "interaction_type": "understanding",
                "total_responses": counts.0,
                "understood": counts.1,
                "not_understood": counts.0 - counts.1,
                "understood_percent": understood_percent,
            }))
        }
        "single_choice" => {
            let rows = sqlx::query_as::<_, (Uuid, String, i64)>(
                r#"
                SELECT interaction_options.id, interaction_options.label, COUNT(responses.id)
                FROM interaction_options
                LEFT JOIN responses
                  ON responses.interaction_id = interaction_options.interaction_id
                 AND responses.cue_run_id = $2
                 AND responses.payload ->> 'option_id' = interaction_options.id::TEXT
                WHERE interaction_options.interaction_id = $1
                GROUP BY interaction_options.id, interaction_options.position
                ORDER BY interaction_options.position, interaction_options.id
                "#,
            )
            .bind(interaction_id)
            .bind(cue_run_id)
            .fetch_all(&mut **transaction)
            .await
            .map_err(persistence_error)?;
            let total_responses = rows.iter().map(|row| row.2).sum::<i64>();
            let options = rows
                .into_iter()
                .map(|row| json!({"option_id": row.0, "label": row.1, "count": row.2}))
                .collect::<Vec<_>>();
            Ok(json!({
                "interaction_type": "single_choice",
                "total_responses": total_responses,
                "options": options,
            }))
        }
        _ => Err(ApiError::bad_request("interaction_type_not_supported")),
    }
}

async fn load_aggregate(
    transaction: &mut Transaction<'_, Postgres>,
    cue_run_id: Uuid,
    interaction_id: Uuid,
) -> Result<Value, ApiError> {
    sqlx::query_scalar::<_, Value>(
        "SELECT aggregate FROM response_aggregates WHERE cue_run_id = $1 AND interaction_id = $2",
    )
    .bind(cue_run_id)
    .bind(interaction_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::internal("response_aggregate_missing"))
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::unauthorized("audience_token_required"))?;
    if value.is_empty() {
        return Err(ApiError::unauthorized("audience_token_required"));
    }
    Ok(value)
}

fn validate_idempotency_key(value: &str) -> Result<(), ApiError> {
    if value.len() < 8
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(ApiError::bad_request("idempotency_key_invalid"));
    }
    Ok(())
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(database_error) = &error
        && database_error.is_unique_violation()
    {
        return ApiError::conflict("response_conflict");
    }
    warn!(%error, "audience response persistence operation failed");
    ApiError::internal("audience_response_failed")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::single_field_object;

    #[test]
    fn response_payload_must_be_an_object_with_one_field() {
        assert!(single_field_object(&json!({"understood": true})).is_ok());
        assert!(single_field_object(&json!({"understood": true, "admin": true})).is_err());
        assert!(single_field_object(&json!([true])).is_err());
    }
}
