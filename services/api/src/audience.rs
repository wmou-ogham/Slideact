use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    auth::{hash_secret, random_token},
    commands::{SessionSnapshot, emit_event_to_all, snapshot_for_session},
    rate_limit::{check as check_rate_limit, client_network_subject},
};

const AUDIENCE_TOKEN_TTL_SECONDS: i64 = 12 * 60 * 60;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JoinRequest {
    join_code: String,
    locale: String,
    participant_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct JoinResponse {
    session_id: Uuid,
    participant_id: Uuid,
    participant_key: String,
    token: String,
    topic: String,
    expires_in_seconds: i64,
    snapshot: SessionSnapshot,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/audience/join", post(join))
}

async fn join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<JoinRequest>,
) -> Result<(StatusCode, Json<JoinResponse>), ApiError> {
    let join_code = normalize_join_code(&request.join_code)?;
    validate_locale(&request.locale)?;
    check_rate_limit(
        &state.redis,
        "audience-join",
        &format!("{}:{join_code}", client_network_subject(&headers)),
        300,
        60,
    )
    .await?;
    let participant_key = match request.participant_key {
        Some(key) => {
            validate_participant_key(&key)?;
            key
        }
        None => random_token(),
    };

    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let session = sqlx::query_as::<_, (Uuid, i64)>(
        r#"
        SELECT id, state_version FROM live_sessions
        WHERE join_code = $1 AND status IN ('lobby', 'live', 'paused')
        FOR UPDATE
        "#,
    )
    .bind(&join_code)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("join_code_not_found"))?;
    let participant_id = upsert_participant(
        &mut transaction,
        session.0,
        &participant_key,
        &request.locale,
    )
    .await?;
    let token = random_token();
    let token_id = Uuid::new_v4();
    let topic = format!("session:{}:audience", session.0);
    sqlx::query(
        r#"
        INSERT INTO session_tokens (
            id, session_id, role, token_hash, resource_scope, expires_at
        )
        VALUES ($1, $2, 'audience', $3, $4, NOW() + ($5::BIGINT * INTERVAL '1 second'))
        "#,
    )
    .bind(token_id)
    .bind(session.0)
    .bind(hash_secret(&token))
    .bind(json!({
        "schema_version": 1,
        "topics": [&topic],
        "participant_id": participant_id,
    }))
    .bind(AUDIENCE_TOKEN_TTL_SECONDS)
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    let participant_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM participants WHERE session_id = $1")
            .bind(session.0)
            .fetch_one(&mut *transaction)
            .await
            .map_err(persistence_error)?;
    emit_event_to_all(
        &mut transaction,
        session.0,
        u64::try_from(session.1).map_err(|_| ApiError::internal("state_version_invalid"))?,
        json!({
            "event_type": "audience.count_updated",
            "count": u32::try_from(participant_count).unwrap_or(u32::MAX),
        }),
        &format!("audience-join-{token_id}"),
    )
    .await?;
    transaction.commit().await.map_err(persistence_error)?;
    let snapshot = snapshot_for_session(&state.database, session.0)
        .await?
        .redact_for_audience();

    Ok((
        StatusCode::CREATED,
        Json(JoinResponse {
            session_id: session.0,
            participant_id,
            participant_key,
            token,
            topic,
            expires_in_seconds: AUDIENCE_TOKEN_TTL_SECONDS,
            snapshot,
        }),
    ))
}

async fn upsert_participant(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    participant_key: &str,
    locale: &str,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO participants (id, session_id, anonymous_key_hash, locale)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (session_id, anonymous_key_hash)
        DO UPDATE SET locale = EXCLUDED.locale, last_seen_at = NOW()
        RETURNING id
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(hash_secret(participant_key))
    .bind(locale)
    .fetch_one(&mut **transaction)
    .await
    .map_err(persistence_error)
}

fn normalize_join_code(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() != 6
        || !value
            .bytes()
            .all(|byte| b"23456789ABCDEFGHJKMNPQRSTUVWXYZ".contains(&byte))
    {
        return Err(ApiError::bad_request("join_code_invalid"));
    }
    Ok(value)
}

fn validate_locale(locale: &str) -> Result<(), ApiError> {
    if matches!(locale, "en" | "zh-TW") {
        Ok(())
    } else {
        Err(ApiError::bad_request("locale_invalid"))
    }
}

fn validate_participant_key(key: &str) -> Result<(), ApiError> {
    if key.len() != 43
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ApiError::bad_request("participant_key_invalid"));
    }
    Ok(())
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "audience join persistence operation failed");
    ApiError::internal("audience_join_failed")
}

#[cfg(test)]
mod tests {
    use super::{normalize_join_code, validate_participant_key};

    #[test]
    fn join_codes_are_normalized_but_ambiguous_characters_are_rejected() {
        assert_eq!(normalize_join_code(" ab2c3d ").unwrap(), "AB2C3D");
        assert!(normalize_join_code("AB10CD").is_err());
        assert!(normalize_join_code("short").is_err());
    }

    #[test]
    fn participant_keys_use_url_safe_256_bit_tokens() {
        assert!(validate_participant_key("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").is_ok());
        assert!(validate_participant_key("too-short").is_err());
    }
}
