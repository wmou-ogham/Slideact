use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    routing::{patch, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{Postgres, Transaction};
use std::collections::HashSet;
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    auth::authenticated_user_id,
    authorization::{SessionRole, authenticate_session_token, require_session_owner},
    commands::emit_event_to_topics,
    rate_limit::check as check_rate_limit,
    result_visibility::results_are_public,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PinWordCloudRequest {
    text: String,
    pinned: bool,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/audience/interactions/{interaction_id}/responses",
            post(submit_response),
        )
        .route(
            "/api/sessions/{session_id}/interactions/{interaction_id}/word-cloud/pin",
            patch(pin_word_cloud_entry),
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
        &interaction.3,
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
    enforce_response_rules(
        &mut transaction,
        ResponseRuleContext {
            interaction_type: &interaction.0,
            settings: &interaction.3,
            cue_run_id: request.cue_run_id,
            interaction_id,
            participant_id,
            payload: &payload,
            idempotent,
        },
    )
    .await?;
    let submission_index = next_submission_index(
        &mut transaction,
        &interaction.0,
        &interaction.3,
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
        let audience_event = if results_are_public(&interaction.3, &interaction.1) {
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

async fn pin_word_cloud_entry(
    State(state): State<AppState>,
    Path((session_id, interaction_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<PinWordCloudRequest>,
) -> Result<Json<Value>, ApiError> {
    authorize_word_cloud_operator(&state.database, &headers, session_id).await?;
    check_rate_limit(
        &state.redis,
        "presenter-command",
        &session_id.to_string(),
        120,
        60,
    )
    .await?;
    let text = normalize_free_text(request.text.trim());
    if text.is_empty() || text.chars().count() > 200 {
        return Err(ApiError::bad_request("response_payload_invalid"));
    }

    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let current = sqlx::query_as::<_, (Uuid, String, i64, Value, Value)>(
        r#"
        SELECT cue_runs.id, cue_runs.state, live_sessions.state_version,
               interactions.settings,
               COALESCE(response_aggregates.aggregate, '{}'::jsonb)
        FROM interactions
        JOIN cues ON cues.id = interactions.cue_id
        JOIN cue_runs ON cue_runs.cue_id = cues.id
        JOIN live_sessions ON live_sessions.id = cue_runs.session_id
                          AND live_sessions.current_cue_run_id = cue_runs.id
        LEFT JOIN response_aggregates
               ON response_aggregates.cue_run_id = cue_runs.id
              AND response_aggregates.interaction_id = interactions.id
        WHERE interactions.id = $1
          AND live_sessions.id = $2
          AND interactions.interaction_type = 'word_cloud'
        FOR UPDATE OF cue_runs
        "#,
    )
    .bind(interaction_id)
    .bind(session_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("interaction_not_found"))?;
    let (cue_run_id, cue_state, state_version, settings, existing) = current;
    if existing.get("interaction_type").and_then(Value::as_str) != Some("word_cloud") {
        return Err(ApiError::not_found("word_cloud_empty"));
    }
    let known = existing
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("text").and_then(Value::as_str))
        .any(|entry| entry == text);
    if !known {
        return Err(ApiError::not_found("word_cloud_entry_not_found"));
    }
    let mut pinned = pinned_texts(&existing);
    if request.pinned {
        if !pinned.iter().any(|item| item == &text) {
            pinned.push(text);
        }
    } else {
        pinned.retain(|item| item != &text);
    }
    let mut aggregate = existing;
    aggregate["pinned"] = json!(pinned);
    sqlx::query(
        r#"
        UPDATE response_aggregates
        SET aggregate = $3, version = version + 1, updated_at = NOW()
        WHERE cue_run_id = $1 AND interaction_id = $2
        "#,
    )
    .bind(cue_run_id)
    .bind(interaction_id)
    .bind(&aggregate)
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    let full_event = json!({
        "event_type": "response.aggregate_updated",
        "cue_run_id": cue_run_id,
        "interaction_id": interaction_id,
        "aggregate": aggregate,
    });
    let invalidation_event = json!({
        "event_type": "response.updated",
        "cue_run_id": cue_run_id,
        "interaction_id": interaction_id,
    });
    let audience_event = if results_are_public(&settings, &cue_state) {
        full_event.clone()
    } else {
        invalidation_event
    };
    emit_event_to_topics(
        &mut transaction,
        session_id,
        u64::try_from(state_version).map_err(|_| ApiError::internal("state_version_invalid"))?,
        [
            ("presenter", full_event),
            ("audience", audience_event.clone()),
            ("overlay", audience_event),
        ],
        &format!("word-cloud-pin-{interaction_id}-{}", Uuid::new_v4()),
    )
    .await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(aggregate))
}

async fn validate_payload(
    transaction: &mut Transaction<'_, Postgres>,
    interaction_id: Uuid,
    interaction_type: &str,
    settings: &Value,
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
            if response_setting_bool(settings, "multiple_selection", false) {
                let values = object
                    .get("option_ids")
                    .and_then(Value::as_array)
                    .filter(|values| (1..=6).contains(&values.len()))
                    .ok_or_else(|| ApiError::bad_request("response_payload_invalid"))?;
                let mut unique = HashSet::with_capacity(values.len());
                let option_ids = values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .and_then(|value| Uuid::parse_str(value).ok())
                            .filter(|option_id| unique.insert(*option_id))
                            .ok_or_else(|| ApiError::bad_request("response_payload_invalid"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let valid_count = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM interaction_options WHERE interaction_id = $1 AND id = ANY($2)",
                )
                .bind(interaction_id)
                .bind(&option_ids)
                .fetch_one(&mut **transaction)
                .await
                .map_err(persistence_error)?;
                if usize::try_from(valid_count).ok() != Some(option_ids.len()) {
                    return Err(ApiError::bad_request("response_option_invalid"));
                }
                return Ok(json!({"option_ids": option_ids}));
            } else {
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

struct ResponseRuleContext<'a> {
    interaction_type: &'a str,
    settings: &'a Value,
    cue_run_id: Uuid,
    interaction_id: Uuid,
    participant_id: Uuid,
    payload: &'a Value,
    idempotent: bool,
}

async fn enforce_response_rules(
    transaction: &mut Transaction<'_, Postgres>,
    context: ResponseRuleContext<'_>,
) -> Result<(), ApiError> {
    let ResponseRuleContext {
        interaction_type,
        settings,
        cue_run_id,
        interaction_id,
        participant_id,
        payload,
        idempotent,
    } = context;
    if idempotent {
        return Ok(());
    }
    if interaction_type != "word_cloud" && !response_setting_bool(settings, "allow_change", true) {
        let exists =
            response_exists(transaction, cue_run_id, interaction_id, participant_id).await?;
        if exists {
            return Err(ApiError::conflict("response_change_not_allowed"));
        }
    }
    if interaction_type == "word_cloud" && !response_setting_bool(settings, "allow_duplicate", true)
    {
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad_request("response_payload_invalid"))?;
        let duplicate = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM responses
                WHERE cue_run_id = $1 AND interaction_id = $2 AND participant_id = $3
                  AND payload ->> 'text' = $4
            )
            "#,
        )
        .bind(cue_run_id)
        .bind(interaction_id)
        .bind(participant_id)
        .bind(text)
        .fetch_one(&mut **transaction)
        .await
        .map_err(persistence_error)?;
        if duplicate {
            return Err(ApiError::conflict("response_duplicate_not_allowed"));
        }
    }
    Ok(())
}

async fn response_exists(
    transaction: &mut Transaction<'_, Postgres>,
    cue_run_id: Uuid,
    interaction_id: Uuid,
    participant_id: Uuid,
) -> Result<bool, ApiError> {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM responses
            WHERE cue_run_id = $1 AND interaction_id = $2 AND participant_id = $3
        )
        "#,
    )
    .bind(cue_run_id)
    .bind(interaction_id)
    .bind(participant_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(persistence_error)
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

async fn next_submission_index(
    transaction: &mut Transaction<'_, Postgres>,
    interaction_type: &str,
    settings: &Value,
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
    if next >= word_cloud_submission_limit(settings) {
        return Err(ApiError::conflict("response_limit_reached"));
    }
    i16::try_from(next).map_err(|_| ApiError::internal("submission_index_invalid"))
}

fn response_setting_bool(settings: &Value, key: &str, default: bool) -> bool {
    settings
        .pointer(&format!("/response/{key}"))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn word_cloud_submission_limit(settings: &Value) -> i64 {
    settings
        .pointer("/response/submission_limit")
        .and_then(Value::as_i64)
        .filter(|limit| (1..=10).contains(limit))
        .unwrap_or(3)
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
            let total_responses = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM responses WHERE cue_run_id = $1 AND interaction_id = $2",
            )
            .bind(cue_run_id)
            .bind(interaction_id)
            .fetch_one(&mut **transaction)
            .await
            .map_err(persistence_error)?;
            let rows = sqlx::query_as::<_, (Uuid, String, i64)>(
                r#"
                SELECT interaction_options.id, interaction_options.label, COUNT(responses.id)
                FROM interaction_options
                LEFT JOIN responses
                 ON responses.interaction_id = interaction_options.interaction_id
                 AND responses.cue_run_id = $2
                 AND (
                       responses.payload ->> 'option_id' = interaction_options.id::TEXT
                       OR EXISTS (
                           SELECT 1
                           FROM jsonb_array_elements_text(
                               CASE
                                   WHEN jsonb_typeof(responses.payload -> 'option_ids') = 'array'
                                   THEN responses.payload -> 'option_ids'
                                   ELSE '[]'::jsonb
                               END
                           ) AS selected(option_id)
                           WHERE selected.option_id = interaction_options.id::TEXT
                       )
                 )
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
            let present: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
            let pinned = load_pinned_words(transaction, cue_run_id, interaction_id)
                .await?
                .into_iter()
                .filter(|text| present.iter().any(|item| item == text))
                .collect::<Vec<_>>();
            let entries = rows
                .into_iter()
                .map(|row| json!({"text": row.0, "count": row.1}))
                .collect::<Vec<_>>();
            Ok(json!({
                "interaction_type": "word_cloud",
                "total_responses": total_responses,
                "entries": entries,
                "pinned": pinned,
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

fn pinned_texts(aggregate: &Value) -> Vec<String> {
    aggregate
        .get("pinned")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

async fn load_pinned_words(
    transaction: &mut Transaction<'_, Postgres>,
    cue_run_id: Uuid,
    interaction_id: Uuid,
) -> Result<Vec<String>, ApiError> {
    let aggregate = sqlx::query_scalar::<_, Value>(
        "SELECT aggregate FROM response_aggregates WHERE cue_run_id = $1 AND interaction_id = $2",
    )
    .bind(cue_run_id)
    .bind(interaction_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    Ok(aggregate.as_ref().map(pinned_texts).unwrap_or_default())
}

async fn authorize_word_cloud_operator(
    database: &sqlx::PgPool,
    headers: &HeaderMap,
    session_id: Uuid,
) -> Result<(), ApiError> {
    if headers.contains_key(header::AUTHORIZATION) {
        let actor = authenticate_session_token(database, bearer_token(headers)?).await?;
        if actor.session_id != session_id
            || !matches!(
                actor.role,
                SessionRole::Owner | SessionRole::Presenter | SessionRole::Controller
            )
        {
            return Err(ApiError::forbidden("presenter_token_required"));
        }
        return Ok(());
    }
    let user_id = authenticated_user_id(database, headers).await?;
    require_session_owner(database, session_id, user_id).await?;
    Ok(())
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
        looks_like_spam, normalize_free_text, pinned_texts, response_setting_bool,
        single_field_object, word_cloud_submission_limit,
    };

    #[test]
    fn response_payload_must_be_an_object_with_one_field() {
        assert!(single_field_object(&json!({"understood": true})).is_ok());
        assert!(single_field_object(&json!({"understood": true, "admin": true})).is_err());
        assert!(single_field_object(&json!([true])).is_err());
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

    #[test]
    fn word_cloud_pinned_texts_are_read_from_the_aggregate() {
        assert_eq!(
            pinned_texts(&json!({"pinned": ["clarity", "focus"]})),
            vec!["clarity".to_string(), "focus".to_string()]
        );
        assert!(pinned_texts(&json!({})).is_empty());
    }

    #[test]
    fn response_rules_keep_legacy_defaults_and_read_explicit_values() {
        assert!(response_setting_bool(&json!({}), "allow_change", true));
        assert!(!response_setting_bool(
            &json!({"response": {"allow_change": false}}),
            "allow_change",
            true
        ));
        assert_eq!(word_cloud_submission_limit(&json!({})), 3);
        assert_eq!(
            word_cloud_submission_limit(&json!({"response": {"submission_limit": 8}})),
            8
        );
        assert_eq!(
            word_cloud_submission_limit(&json!({"response": {"submission_limit": 20}})),
            3
        );
    }
}
