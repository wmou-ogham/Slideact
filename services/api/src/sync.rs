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
    authorization::{
        SessionRole, authenticate_session_token, authorize_presenter_access, bearer_token,
        require_session_owner,
    },
    commands::{SessionSnapshot, apply_follow_position, emit_event_to_all, snapshot_for_session},
    rate_limit::check as check_rate_limit,
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
    device_id: String,
    deck_id: String,
    slide_id: Option<String>,
    slide_index: Option<u32>,
    detected_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeartbeatRequest {
    device_id: String,
    deck_id: Option<String>,
    slide_id: Option<String>,
    slide_index: Option<u32>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
struct HeartbeatResponse {
    connected: bool,
    sync_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NavigationRequest {
    direction: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct NavigationCommand {
    id: Uuid,
    direction: String,
}

#[derive(Debug, Serialize)]
struct NavigationQueuedResponse {
    accepted: bool,
    command_id: Uuid,
}

#[derive(Debug, Serialize)]
struct ExtensionNavigationResponse {
    command: Option<NavigationCommand>,
}

#[derive(Debug, Serialize)]
struct ExtensionStatusResponse {
    paired: bool,
    connected: bool,
    device_id: Option<String>,
    deck_id: Option<String>,
    slide_id: Option<String>,
    slide_index: Option<u32>,
    last_error: Option<String>,
    heartbeat_at: Option<String>,
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
        .route("/api/extension/heartbeat", post(extension_heartbeat))
        .route(
            "/api/extension/navigation",
            axum::routing::get(take_navigation),
        )
        .route(
            "/api/sessions/{session_id}/navigation",
            post(queue_navigation),
        )
        .route(
            "/api/sessions/{session_id}/extension-status",
            axum::routing::get(extension_status),
        )
        .route(
            "/api/sessions/{session_id}/sync-mode",
            put(update_sync_mode),
        )
}

async fn queue_navigation(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<NavigationRequest>,
) -> Result<Json<NavigationQueuedResponse>, ApiError> {
    let access = authorize_presenter_access(&state.database, &headers, session_id).await?;
    if !matches!(request.direction.as_str(), "previous" | "next") {
        return Err(ApiError::bad_request("navigation_direction_invalid"));
    }
    check_rate_limit(
        &state.redis,
        "presentation-navigation",
        &format!("{session_id}:{}", access.actor_scope()),
        120,
        60,
    )
    .await?;
    let command = NavigationCommand {
        id: Uuid::new_v4(),
        direction: request.direction,
    };
    let payload = serde_json::to_string(&command)
        .map_err(|_| ApiError::internal("navigation_command_invalid"))?;
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(redis_error)?;
    let _: i64 = redis::cmd("RPUSH")
        .arg(navigation_key(session_id))
        .arg(payload)
        .query_async(&mut connection)
        .await
        .map_err(redis_error)?;
    let _: String = redis::cmd("LTRIM")
        .arg(navigation_key(session_id))
        .arg(-20)
        .arg(-1)
        .query_async(&mut connection)
        .await
        .map_err(redis_error)?;
    let _: bool = redis::cmd("EXPIRE")
        .arg(navigation_key(session_id))
        .arg(30)
        .query_async(&mut connection)
        .await
        .map_err(redis_error)?;
    Ok(Json(NavigationQueuedResponse {
        accepted: true,
        command_id: command.id,
    }))
}

async fn take_navigation(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ExtensionNavigationResponse>, ApiError> {
    let actor = authenticate_session_token(&state.database, bearer_token(&headers)?).await?;
    if actor.role != SessionRole::Extension {
        return Err(ApiError::forbidden("extension_token_required"));
    }
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(redis_error)?;
    let payload: Option<String> = redis::cmd("LPOP")
        .arg(navigation_key(actor.session_id))
        .query_async(&mut connection)
        .await
        .map_err(redis_error)?;
    let command = payload
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(|_| ApiError::internal("navigation_command_invalid"))?;
    Ok(Json(ExtensionNavigationResponse { command }))
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
    sqlx::query(
        "UPDATE live_sessions SET sync_mode = 'auto_connected', state_version = state_version + 1 WHERE id = $1",
    )
    .bind(session_id)
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
    touch_controller(
        &state.database,
        actor.session_id,
        &request.device_id,
        Some(request.deck_id.trim()),
        request.slide_id.as_deref(),
        request.slide_index,
        None,
    )
    .await?;
    let sync_mode =
        sqlx::query_scalar::<_, String>("SELECT sync_mode FROM live_sessions WHERE id = $1")
            .bind(actor.session_id)
            .fetch_one(&state.database)
            .await
            .map_err(persistence_error)?;
    if matches!(sync_mode.as_str(), "manual" | "auto_paused") {
        return Ok(Json(PositionResponse {
            matched: false,
            cue_id: None,
            snapshot: snapshot_for_session(&state.database, actor.session_id).await?,
        }));
    }
    if matches!(sync_mode.as_str(), "disconnected" | "resync_required") {
        return Err(ApiError::conflict("sync_resync_required"));
    }
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

async fn extension_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HeartbeatRequest>,
) -> Result<Json<HeartbeatResponse>, ApiError> {
    let actor = authenticate_session_token(&state.database, bearer_token(&headers)?).await?;
    if actor.role != SessionRole::Extension {
        return Err(ApiError::forbidden("extension_token_required"));
    }
    validate_device_id(&request.device_id)?;
    if request
        .last_error
        .as_ref()
        .is_some_and(|value| value.chars().count() > 300)
    {
        return Err(ApiError::bad_request("extension_error_invalid"));
    }
    touch_controller(
        &state.database,
        actor.session_id,
        &request.device_id,
        request.deck_id.as_deref(),
        request.slide_id.as_deref(),
        request.slide_index,
        request.last_error.as_deref(),
    )
    .await?;
    let mut sync_mode =
        sqlx::query_scalar::<_, String>("SELECT sync_mode FROM live_sessions WHERE id = $1")
            .bind(actor.session_id)
            .fetch_one(&state.database)
            .await
            .map_err(persistence_error)?;
    if sync_mode == "disconnected" {
        sync_mode = transition_sync_mode(
            &state.database,
            actor.session_id,
            "resync_required",
            "extension-reconnected",
        )
        .await?;
    }
    Ok(Json(HeartbeatResponse {
        connected: true,
        sync_mode,
    }))
}

async fn extension_status(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ExtensionStatusResponse>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;
    let row = sqlx::query_as::<_, (String, serde_json::Value, String, bool, String)>(
        r#"
        SELECT connection_key, metadata, heartbeat_at::TEXT,
               heartbeat_at > NOW() - INTERVAL '70 seconds', live_sessions.sync_mode
        FROM controller_connections
        JOIN live_sessions ON live_sessions.id = controller_connections.session_id
        WHERE controller_connections.session_id = $1 AND controller_type = 'extension'
        ORDER BY controller_connections.heartbeat_at DESC LIMIT 1
        "#,
    )
    .bind(session_id)
    .fetch_optional(&state.database)
    .await
    .map_err(persistence_error)?;
    let Some((device_id, metadata, heartbeat_at, connected, sync_mode)) = row else {
        return Ok(Json(ExtensionStatusResponse {
            paired: false,
            connected: false,
            device_id: None,
            deck_id: None,
            slide_id: None,
            slide_index: None,
            last_error: None,
            heartbeat_at: None,
        }));
    };
    if !connected && matches!(sync_mode.as_str(), "auto_connected" | "auto_paused") {
        transition_sync_mode(
            &state.database,
            session_id,
            "disconnected",
            "extension-heartbeat-timeout",
        )
        .await?;
    }
    Ok(Json(ExtensionStatusResponse {
        paired: true,
        connected,
        device_id: Some(device_id),
        deck_id: metadata
            .get("deck_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        slide_id: metadata
            .get("slide_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        slide_index: metadata
            .get("slide_index")
            .and_then(|value| value.as_u64())
            .and_then(|value| u32::try_from(value).ok()),
        last_error: metadata
            .get("last_error")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        heartbeat_at: Some(heartbeat_at),
    }))
}

async fn update_sync_mode(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<SyncModeRequest>,
) -> Result<Json<SessionSnapshot>, ApiError> {
    if !matches!(
        request.mode.as_str(),
        "auto_connected" | "auto_paused" | "manual" | "disconnected" | "resync_required"
    ) {
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

async fn transition_sync_mode(
    database: &sqlx::PgPool,
    session_id: Uuid,
    mode: &str,
    event_key: &str,
) -> Result<String, ApiError> {
    let mut transaction = database.begin().await.map_err(persistence_error)?;
    let state_version = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE live_sessions SET sync_mode = $2, state_version = state_version + 1
        WHERE id = $1 AND sync_mode <> $2 RETURNING state_version
        "#,
    )
    .bind(session_id)
    .bind(mode)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    if let Some(state_version) = state_version {
        emit_event_to_all(
            &mut transaction,
            session_id,
            u64::try_from(state_version)
                .map_err(|_| ApiError::internal("state_version_invalid"))?,
            json!({"event_type": "sync.mode_changed", "sync_mode": mode}),
            &format!("{event_key}-{state_version}"),
        )
        .await?;
    }
    transaction.commit().await.map_err(persistence_error)?;
    Ok(mode.to_owned())
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

async fn touch_controller(
    database: &sqlx::PgPool,
    session_id: Uuid,
    device_id: &str,
    deck_id: Option<&str>,
    slide_id: Option<&str>,
    slide_index: Option<u32>,
    last_error: Option<&str>,
) -> Result<(), ApiError> {
    validate_device_id(device_id)?;
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
    .bind(device_id.trim())
    .bind(json!({
        "deck_id": deck_id,
        "slide_id": slide_id,
        "slide_index": slide_index,
        "last_error": last_error,
    }))
    .execute(database)
    .await
    .map_err(persistence_error)?;
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
    validate_device_id(&position.device_id)?;
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

fn validate_device_id(device_id: &str) -> Result<(), ApiError> {
    if device_id.trim().is_empty() || device_id.chars().count() > 200 {
        return Err(ApiError::bad_request("device_id_invalid"));
    }
    Ok(())
}

fn navigation_key(session_id: Uuid) -> String {
    format!("extension:navigation:{session_id}")
}

fn redis_error(error: redis::RedisError) -> ApiError {
    warn!(%error, "extension navigation Redis operation failed");
    ApiError::internal("extension_navigation_failed")
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "extension sync persistence operation failed");
    ApiError::internal("extension_sync_failed")
}
