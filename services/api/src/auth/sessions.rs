use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{AppState, api_error::ApiError};

use super::{
    DEFAULT_SESSION_TTL_SECONDS, SESSION_COOKIE,
    support::{
        boolean_env, build_cookie, clear_cookie, database_error, duration_env, hash_secret,
        random_token, read_cookie,
    },
};

#[derive(Debug, Serialize)]
pub(super) struct AuthenticatedProfile {
    pub(super) id: Uuid,
    pub(super) display_name: String,
    pub(super) locale: String,
    pub(super) email: Option<String>,
    pub(super) account_type: String,
    pub(super) vault_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DevLoginRequest {
    display_name: String,
    locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DeleteAccountRequest {
    confirmation: String,
}

pub(super) async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DeleteAccountRequest>,
) -> Result<Response, ApiError> {
    if request.confirmation != "DELETE" {
        return Err(ApiError::bad_request(
            "account_deletion_confirmation_invalid",
        ));
    }
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    let mut transaction = state.database.begin().await.map_err(database_error)?;
    sqlx::query("DELETE FROM projects WHERE owner_id = $1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    let deleted = sqlx::query("DELETE FROM profiles WHERE id = $1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
    if deleted != 1 {
        return Err(ApiError::not_found("account_not_found"));
    }
    transaction.commit().await.map_err(database_error)?;
    info!(%user_id, "account and owned presentation data deleted");

    let secure = state
        .google_auth
        .as_ref()
        .is_none_or(|auth| auth.0.secure_cookies);
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_cookie(SESSION_COOKIE, "/", secure))
            .expect("generated cookie header must be valid"),
    );
    Ok(response)
}

pub(super) async fn dev_login(
    State(state): State<AppState>,
    Json(request): Json<DevLoginRequest>,
) -> Result<Response, ApiError> {
    if !boolean_env("DEV_AUTH_ENABLED", false).map_err(|error| {
        warn!(%error, "invalid development authentication setting");
        ApiError::internal("dev_auth_configuration_invalid")
    })? {
        return Err(ApiError::not_found("dev_auth_not_enabled"));
    }
    let display_name = request.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 100 {
        return Err(ApiError::bad_request("display_name_invalid"));
    }
    if !matches!(request.locale.as_str(), "en" | "zh-TW") {
        return Err(ApiError::bad_request("locale_invalid"));
    }
    let user_id = Uuid::new_v4();
    let session_token = random_token();
    let session_id = Uuid::new_v4();
    let session_ttl_seconds = duration_env("AUTH_SESSION_TTL_SECONDS", DEFAULT_SESSION_TTL_SECONDS)
        .map_err(|error| {
            warn!(%error, "invalid authentication session TTL");
            ApiError::internal("dev_auth_configuration_invalid")
        })?;
    let secure_cookies = boolean_env("AUTH_COOKIE_SECURE", true).map_err(|error| {
        warn!(%error, "invalid authentication cookie setting");
        ApiError::internal("dev_auth_configuration_invalid")
    })?;
    let mut transaction = state.database.begin().await.map_err(|error| {
        warn!(%error, "failed to begin development login transaction");
        ApiError::internal("dev_auth_failed")
    })?;
    sqlx::query("INSERT INTO profiles (id, display_name, locale) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(display_name)
        .bind(&request.locale)
        .execute(&mut *transaction)
        .await
        .map_err(|error| {
            warn!(%error, "failed to persist development profile");
            ApiError::internal("dev_auth_failed")
        })?;
    sqlx::query(
        r#"
        INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, NOW() + ($4::BIGINT * INTERVAL '1 second'))
        "#,
    )
    .bind(session_id)
    .bind(user_id)
    .bind(hash_secret(&session_token))
    .bind(
        i64::try_from(session_ttl_seconds)
            .map_err(|_| ApiError::internal("dev_auth_configuration_invalid"))?,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        warn!(%error, "failed to persist development session");
        ApiError::internal("dev_auth_failed")
    })?;
    transaction.commit().await.map_err(|error| {
        warn!(%error, "failed to commit development login");
        ApiError::internal("dev_auth_failed")
    })?;

    let cookie = build_cookie(
        SESSION_COOKIE,
        &session_token,
        "/",
        session_ttl_seconds,
        secure_cookies,
    );
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("generated cookie header must be valid"),
    );
    Ok(response)
}

pub(super) async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AuthenticatedProfile>, ApiError> {
    let token = read_cookie(&headers, SESSION_COOKIE)
        .ok_or_else(|| ApiError::unauthorized("authentication_required"))?;
    let token_hash = hash_secret(token);
    let profile = sqlx::query_as::<_, (Uuid, String, String, Option<String>, Option<Uuid>)>(
        r#"
        SELECT profiles.id, profiles.display_name, profiles.locale, oauth_identities.email,
               guest_vaults.id
        FROM user_sessions
        JOIN profiles ON profiles.id = user_sessions.user_id
        LEFT JOIN oauth_identities
          ON oauth_identities.user_id = profiles.id AND oauth_identities.provider = 'google'
        LEFT JOIN guest_vaults ON guest_vaults.user_id = profiles.id
        WHERE user_sessions.token_hash = $1
          AND user_sessions.revoked_at IS NULL
          AND user_sessions.expires_at > NOW()
        "#,
    )
    .bind(token_hash)
    .fetch_optional(&state.database)
    .await
    .map_err(|error| {
        warn!(%error, "failed to load authenticated profile");
        ApiError::internal("auth_session_lookup_failed")
    })?
    .ok_or_else(|| ApiError::unauthorized("authentication_required"))?;

    Ok(Json(AuthenticatedProfile {
        id: profile.0,
        display_name: profile.1,
        locale: profile.2,
        email: profile.3,
        account_type: if profile.4.is_some() {
            "guest"
        } else {
            "google"
        }
        .to_owned(),
        vault_id: profile.4,
    }))
}

pub(super) async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(token) = read_cookie(&headers, SESSION_COOKIE) {
        sqlx::query(
            "UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
        )
        .bind(hash_secret(token))
        .execute(&state.database)
        .await
        .map_err(|error| {
            warn!(%error, "failed to revoke application session");
            ApiError::internal("auth_logout_failed")
        })?;
    }

    let secure = state
        .google_auth
        .as_ref()
        .is_none_or(|auth| auth.0.secure_cookies);
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_cookie(SESSION_COOKIE, "/", secure))
            .expect("generated cookie header must be valid"),
    );
    Ok(response)
}

pub(crate) async fn authenticated_user_id(
    database: &sqlx::PgPool,
    headers: &HeaderMap,
) -> Result<Uuid, ApiError> {
    let token = read_cookie(headers, SESSION_COOKIE)
        .ok_or_else(|| ApiError::unauthorized("authentication_required"))?;
    sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT user_id
        FROM user_sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
        "#,
    )
    .bind(hash_secret(token))
    .fetch_optional(database)
    .await
    .map_err(|error| {
        warn!(%error, "failed to resolve authenticated application session");
        ApiError::internal("auth_session_lookup_failed")
    })?
    .ok_or_else(|| ApiError::unauthorized("authentication_required"))
}
