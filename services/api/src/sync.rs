use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{post, put},
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    auth::{authenticated_user_id, hash_secret, random_token},
    authorization::{SessionRole, authenticate_session_token, bearer_token, require_session_owner},
    commands::{SessionSnapshot, apply_follow_position, emit_event_to_all, snapshot_for_session},
};

const PAIRING_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_TTL_SECONDS: i64 = 10 * 60;
const EXTENSION_TOKEN_TTL_SECONDS: i64 = 24 * 60 * 60;
const OVERLAY_TOKEN_TTL_SECONDS: i64 = 60 * 60;

#[derive(Debug, Serialize)]
struct PairingCodeResponse {
    code: String,
    expires_in_seconds: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RedeemPairingRequest {
    code: String,
    device_id: String,
}

#[derive(Debug, Serialize)]
struct RedeemPairingResponse {
    session_id: Uuid,
    token: String,
    topic: String,
    overlay_token: String,
    expires_in_seconds: i64,
    snapshot: SessionSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PositionRequest {
    deck_id: String,
    slide_id: Option<String>,
    slide_index: Option<u32>,
    detected_at: u64,
}

#[derive(Debug, Serialize)]
struct PositionResponse {
    matched: bool,
    cue_id: Option<Uuid>,
    snapshot: SessionSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncModeRequest {
    mode: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sessions/{session_id}/extension-pairing",
            post(create_pairing_code),
        )
        .route("/api/extension/pair", post(redeem_pairing_code))
        .route("/api/extension/position", post(report_position))
        .route(
            "/api/sessions/{session_id}/sync-mode",
            put(update_sync_mode),
        )
}

async fn create_pairing_code(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<PairingCodeResponse>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;
    let code = generate_pairing_code();
    sqlx::query(
        r#"
        INSERT INTO extension_pairing_codes (id, session_id, code_hash, expires_at)
        VALUES ($1, $2, $3, NOW() + ($4::BIGINT * INTERVAL '1 second'))
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(hash_secret(&code))
    .bind(PAIRING_TTL_SECONDS)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;
    Ok((
        StatusCode::CREATED,
        Json(PairingCodeResponse {
            code,
            expires_in_seconds: PAIRING_TTL_SECONDS,
        }),
    ))
}

async fn redeem_pairing_code(
    State(state): State<AppState>,
    Json(request): Json<RedeemPairingRequest>,
) -> Result<Json<RedeemPairingResponse>, ApiError> {
    validate_pairing_code(&request.code)?;
    if request.device_id.trim().is_empty() || request.device_id.chars().count() > 200 {
        return Err(ApiError::bad_request("device_id_invalid"));
    }
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let session_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        UPDATE extension_pairing_codes SET redeemed_at = NOW()
        WHERE id = (
            SELECT id FROM extension_pairing_codes
            WHERE code_hash = $1 AND redeemed_at IS NULL AND expires_at > NOW()
            FOR UPDATE SKIP LOCKED
        )
        RETURNING session_id
        "#,
    )
    .bind(hash_secret(&request.code.to_uppercase()))
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("pairing_code_invalid"))?;
    let extension_token = random_token();
    insert_session_token(
        &mut transaction,
        session_id,
        "extension",
        &extension_token,
        EXTENSION_TOKEN_TTL_SECONDS,
        "presenter",
    )
    .await?;
    let overlay_token = random_token();
    insert_session_token(
        &mut transaction,
        session_id,
        "overlay",
        &overlay_token,
        OVERLAY_TOKEN_TTL_SECONDS,
        "overlay",
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO controller_connections (
            id, session_id, controller_type, connection_key, metadata
        ) VALUES ($1, $2, 'extension', $3, $4)
        ON CONFLICT (session_id, controller_type, connection_key)
        DO UPDATE SET metadata = EXCLUDED.metadata, heartbeat_at = NOW(), disconnected_at = NULL
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(request.device_id.trim())
    .bind(json!({"paired": true}))
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    transaction.commit().await.map_err(persistence_error)?;
    info!(%session_id, "Google Slides extension paired");
    Ok(Json(RedeemPairingResponse {
        session_id,
        token: extension_token,
        topic: format!("session:{session_id}:presenter"),
        overlay_token,
        expires_in_seconds: EXTENSION_TOKEN_TTL_SECONDS,
        snapshot: snapshot_for_session(&state.database, session_id).await?,
    }))
}

async fn report_position(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PositionRequest>,
) -> Result<Json<PositionResponse>, ApiError> {
    let actor = authenticate_session_token(&state.database, bearer_token(&headers)?).await?;
    if actor.role != SessionRole::Extension {
        return Err(ApiError::forbidden("extension_token_required"));
    }
    validate_position(&request)?;
    bind_deck(&state.database, actor.session_id, request.deck_id.trim()).await?;
    let (snapshot, cue_id) = apply_follow_position(
        &state.database,
        actor.session_id,
        request.slide_id.as_deref(),
        request.slide_index,
        &format!("extension-position-{}", request.detected_at),
    )
    .await?;
    Ok(Json(PositionResponse {
        matched: cue_id.is_some(),
        cue_id,
        snapshot,
    }))
}

async fn update_sync_mode(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<SyncModeRequest>,
) -> Result<Json<SessionSnapshot>, ApiError> {
    if request.mode != "manual" && request.mode != "auto_connected" {
        return Err(ApiError::bad_request("sync_mode_invalid"));
    }
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let state_version = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE live_sessions SET sync_mode = $2, state_version = state_version + 1
        WHERE id = $1 RETURNING state_version
        "#,
    )
    .bind(session_id)
    .bind(&request.mode)
    .fetch_one(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    emit_event_to_all(
        &mut transaction,
        session_id,
        u64::try_from(state_version).map_err(|_| ApiError::internal("state_version_invalid"))?,
        json!({"event_type": "sync.mode_changed", "sync_mode": request.mode}),
        &format!("sync-mode-{state_version}"),
    )
    .await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(
        snapshot_for_session(&state.database, session_id).await?,
    ))
}

async fn insert_session_token(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    role: &str,
    token: &str,
    ttl_seconds: i64,
    topic_suffix: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO session_tokens (id, session_id, role, token_hash, resource_scope, expires_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + ($6::BIGINT * INTERVAL '1 second'))
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(role)
    .bind(hash_secret(token))
    .bind(json!({
        "schema_version": 1,
        "topics": [format!("session:{session_id}:{topic_suffix}")],
    }))
    .bind(ttl_seconds)
    .execute(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    Ok(())
}

async fn bind_deck(
    database: &sqlx::PgPool,
    session_id: Uuid,
    deck_id: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        r#"
        INSERT INTO presentation_bindings (session_id, deck_id)
        VALUES ($1, $2)
        ON CONFLICT (session_id) DO NOTHING
        "#,
    )
    .bind(session_id)
    .bind(deck_id)
    .execute(database)
    .await
    .map_err(persistence_error)?;
    if result.rows_affected() == 0 {
        let matches = sqlx::query_scalar::<_, bool>(
            "SELECT deck_id = $2 FROM presentation_bindings WHERE session_id = $1",
        )
        .bind(session_id)
        .bind(deck_id)
        .fetch_one(database)
        .await
        .map_err(persistence_error)?;
        if !matches {
            return Err(ApiError::conflict("deck_not_paired"));
        }
    }
    Ok(())
}

fn generate_pairing_code() -> String {
    let mut rng = rand::rng();
    (0..8)
        .map(|_| PAIRING_ALPHABET[rng.random_range(0..PAIRING_ALPHABET.len())] as char)
        .collect()
}

fn validate_pairing_code(code: &str) -> Result<(), ApiError> {
    if code.len() != 8
        || !code
            .bytes()
            .all(|byte| PAIRING_ALPHABET.contains(&byte.to_ascii_uppercase()))
    {
        return Err(ApiError::bad_request("pairing_code_invalid"));
    }
    Ok(())
}

fn validate_position(position: &PositionRequest) -> Result<(), ApiError> {
    if position.deck_id.trim().is_empty()
        || position.deck_id.chars().count() > 300
        || position
            .slide_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.chars().count() > 300)
        || position.slide_index.is_some_and(|value| value > 100_000)
        || (position.slide_id.is_none() && position.slide_index.is_none())
    {
        return Err(ApiError::bad_request("presentation_position_invalid"));
    }
    Ok(())
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "extension sync persistence operation failed");
    ApiError::internal("extension_sync_failed")
}
