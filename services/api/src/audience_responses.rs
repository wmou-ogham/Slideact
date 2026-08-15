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
    commands::emit_event_to_topics,
    rate_limit::check as check_rate_limit,
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
    check_rate_limit(
        &state.redis,
        "audience-response",
        &participant_id.to_string(),
        20,
        60,
    )
    .await?;

    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))")
        .bind(request.cue_run_id)
        .execute(&mut *transaction)
        .await
        .map_err(persistence_error)?;
    let interaction = sqlx::query_as::<_, (String, String, i64, Value)>(
        r#"
        SELECT interactions.interaction_type, cue_runs.state, live_sessions.state_version,
               interactions.settings
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
    let payload = validate_payload(
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
    let submission_index = next_submission_index(
        &mut transaction,
        &interaction.0,
        request.cue_run_id,
        interaction_id,
        participant_id,
        idempotent,
    )
    .await?;

    let aggregate = if idempotent {
        load_aggregate(&mut transaction, request.cue_run_id, interaction_id).await?
    } else {
        sqlx::query(
            r#"
            INSERT INTO responses (
                id, cue_run_id, interaction_id, participant_id,
                submission_index, idempotency_key, payload
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
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
        .bind(submission_index)
        .bind(&request.idempotency_key)
        .bind(&payload)
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
        let full_event = json!({
            "event_type": "response.aggregate_updated",
            "cue_run_id": request.cue_run_id,
            "interaction_id": interaction_id,
            "aggregate": aggregate,
        });
        let invalidation_event = json!({
            "event_type": "response.updated",
            "cue_run_id": request.cue_run_id,
            "interaction_id": interaction_id,
        });
        let audience_event = if audience_can_see_aggregate(&interaction.3, &interaction.1) {
            full_event.clone()
        } else {
            invalidation_event
        };
        emit_event_to_topics(
            &mut transaction,
            actor.session_id,
            u64::try_from(interaction.2)
                .map_err(|_| ApiError::internal("state_version_invalid"))?,
            [
                ("presenter", full_event),
                ("audience", audience_event.clone()),
                ("overlay", audience_event),
            ],
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
) -> Result<Value, ApiError> {
    let object = single_field_object(payload)?;
    match interaction_type {
        "understanding" => {
            let legacy_valid = object.get("understood").is_some_and(Value::is_boolean);
            let level_valid = object
                .get("level")
                .and_then(Value::as_str)
                .is_some_and(|level| matches!(level, "green" | "yellow" | "red"));
            if !legacy_valid && !level_valid {
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
        "word_cloud" => {
            let text = object
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::bad_request("response_payload_invalid"))?;
            if text.chars().count() > 200 {
                return Err(ApiError::bad_request("response_payload_invalid"));
            }
            let text = normalize_free_text(text);
            if looks_like_spam(&text, 1, 14) {
                return Err(ApiError::bad_request("response_text_rejected"));
            }
            return Ok(json!({"text": text}));
        }
        _ => return Err(ApiError::bad_request("interaction_type_not_supported")),
    }
    Ok(payload.clone())
}

fn normalize_free_text(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\u{3000}' => ' ',
            '\u{ff01}'..='\u{ff5e}' => char::from_u32(character as u32 - 0xfee0)
                .expect("full-width ASCII conversion is valid"),
            _ => character,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn looks_like_spam(value: &str, maximum_urls: usize, maximum_run: usize) -> bool {
    let lowercase = value.to_lowercase();
    let url_count = lowercase.matches("http://").count() + lowercase.matches("https://").count();
    if url_count > maximum_urls {
        return true;
    }
    let mut previous = None;
    let mut run = 0;
    for character in value.chars() {
        if Some(character) == previous {
            run += 1;
        } else {
            previous = Some(character);
            run = 1;
        }
        if run > maximum_run {
            return true;
        }
    }
    false
}

const WORD_CLOUD_MAX_SUBMISSIONS: i64 = 3;

async fn next_submission_index(
    transaction: &mut Transaction<'_, Postgres>,
    interaction_type: &str,
    cue_run_id: Uuid,
    interaction_id: Uuid,
    participant_id: Uuid,
    idempotent: bool,
) -> Result<i16, ApiError> {
    if interaction_type != "word_cloud" || idempotent {
        return Ok(0);
    }
    let next = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE((MAX(submission_index) + 1)::BIGINT, 0)
        FROM responses
        WHERE cue_run_id = $1 AND interaction_id = $2 AND participant_id = $3
        "#,
    )
    .bind(cue_run_id)
    .bind(interaction_id)
    .bind(participant_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    if next >= WORD_CLOUD_MAX_SUBMISSIONS {
        return Err(ApiError::conflict("response_limit_reached"));
    }
    i16::try_from(next).map_err(|_| ApiError::internal("submission_index_invalid"))
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
            let counts = sqlx::query_as::<_, (i64, i64, i64, i64)>(
                r#"
                SELECT COUNT(*),
                       COUNT(*) FILTER (
                           WHERE payload ->> 'level' = 'green'
                              OR payload ->> 'understood' = 'true'
                       ),
                       COUNT(*) FILTER (WHERE payload ->> 'level' = 'yellow'),
                       COUNT(*) FILTER (
                           WHERE payload ->> 'level' = 'red'
                              OR payload ->> 'understood' = 'false'
                       )
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
                "not_understood": counts.2 + counts.3,
                "understood_percent": understood_percent,
                "green": counts.1,
                "yellow": counts.2,
                "red": counts.3,
                "green_percent": percentage(counts.1, counts.0),
                "yellow_percent": percentage(counts.2, counts.0),
                "red_percent": percentage(counts.3, counts.0),
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
        "word_cloud" => {
            let rows = sqlx::query_as::<_, (String, i64)>(
                r#"
                SELECT payload ->> 'text' AS text, COUNT(*)
                FROM responses
                WHERE cue_run_id = $1 AND interaction_id = $2
                GROUP BY text
                ORDER BY COUNT(*) DESC, text ASC
                LIMIT 50
                "#,
            )
            .bind(cue_run_id)
            .bind(interaction_id)
            .fetch_all(&mut **transaction)
            .await
            .map_err(persistence_error)?;
            let total_responses = rows.iter().map(|row| row.1).sum::<i64>();
            let entries = rows
                .into_iter()
                .map(|row| json!({"text": row.0, "count": row.1}))
                .collect::<Vec<_>>();
            Ok(json!({
                "interaction_type": "word_cloud",
                "total_responses": total_responses,
                "entries": entries,
            }))
        }
        _ => Err(ApiError::bad_request("interaction_type_not_supported")),
    }
}

fn percentage(count: i64, total: i64) -> f64 {
    if total == 0 {
        0.0
    } else {
        count as f64 * 100.0 / total as f64
    }
}

fn audience_can_see_aggregate(settings: &Value, cue_state: &str) -> bool {
    match settings
        .pointer("/results/audience_visibility")
        .and_then(Value::as_str)
        .unwrap_or("after_reveal")
    {
        "live" => true,
        "after_reveal" => cue_state == "revealed",
        _ => false,
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

    use super::{
        audience_can_see_aggregate, looks_like_spam, normalize_free_text, single_field_object,
    };

    #[test]
    fn response_payload_must_be_an_object_with_one_field() {
        assert!(single_field_object(&json!({"understood": true})).is_ok());
        assert!(single_field_object(&json!({"understood": true, "admin": true})).is_err());
        assert!(single_field_object(&json!([true])).is_err());
    }

    #[test]
    fn audience_aggregate_visibility_defaults_to_reveal() {
        assert!(audience_can_see_aggregate(
            &json!({"results": {"audience_visibility": "live"}}),
            "open"
        ));
        assert!(!audience_can_see_aggregate(&json!({}), "open"));
        assert!(audience_can_see_aggregate(&json!({}), "revealed"));
        assert!(!audience_can_see_aggregate(
            &json!({"results": {"audience_visibility": "presenter_only"}}),
            "revealed"
        ));
    }

    #[test]
    fn word_cloud_text_is_normalized_and_obvious_spam_is_rejected() {
        assert_eq!(
            normalize_free_text("  Ｃｌａｒｉｔｙ\nROCKS  "),
            "clarity rocks"
        );
        assert!(looks_like_spam("aaaaaaaaaaaaaaa", 1, 14));
        assert!(looks_like_spam(
            "https://one.example https://two.example",
            1,
            14
        ));
        assert!(!looks_like_spam("clear examples", 1, 14));
    }
}
