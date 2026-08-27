use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    rate_limit::{check as check_rate_limit, client_network_subject},
};

use super::{
    SESSION_COOKIE,
    sessions::AuthenticatedProfile,
    support::{
        build_cookie, database_error, hash_secret, random_token, read_cookie, validate_locale,
    },
};

const GUEST_COOKIE_MAX_AGE_SECONDS: u64 = 10 * 365 * 24 * 60 * 60;
const GUEST_VAULT_RECOVERY_PREFIX: &str = "svlt1.";

#[derive(Debug, Serialize)]
struct GuestSessionResponse {
    vault_id: Uuid,
    profile: AuthenticatedProfile,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GuestLoginRequest {
    locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RestoreGuestVaultRequest {
    recovery_key: String,
}

#[derive(Debug, Serialize)]
pub(super) struct GuestVaultFile {
    kind: &'static str,
    version: u8,
    vault_id: Uuid,
    recovery_key: String,
}

pub(super) async fn guest_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<GuestLoginRequest>,
) -> Result<Response, ApiError> {
    validate_locale(&request.locale)?;
    let secure_cookies = state
        .google_auth
        .as_ref()
        .is_some_and(|auth| auth.0.secure_cookies);

    if let Some(existing_token) = read_cookie(&headers, SESSION_COOKIE)
        && let Some(existing) = load_guest_session(&state.database, existing_token).await?
    {
        sqlx::query("UPDATE guest_vaults SET last_seen_at = NOW() WHERE id = $1")
            .bind(existing.vault_id)
            .execute(&state.database)
            .await
            .map_err(database_error)?;
        return guest_response(existing, existing_token, secure_cookies, StatusCode::OK);
    }

    let user_id = Uuid::new_v4();
    let vault_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let session_token = random_token();
    let mut transaction = state.database.begin().await.map_err(database_error)?;
    sqlx::query("INSERT INTO profiles (id, display_name, locale) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind("Guest")
        .bind(&request.locale)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query("INSERT INTO guest_vaults (id, user_id) VALUES ($1, $2)")
        .bind(vault_id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query(
        r#"
        INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, 'infinity'::timestamptz)
        "#,
    )
    .bind(session_id)
    .bind(user_id)
    .bind(hash_secret(&session_token))
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    let profile = AuthenticatedProfile {
        id: user_id,
        display_name: "Guest".to_owned(),
        locale: request.locale,
        email: None,
        account_type: "guest".to_owned(),
        vault_id: Some(vault_id),
    };
    guest_response(
        GuestSessionResponse { vault_id, profile },
        &session_token,
        secure_cookies,
        StatusCode::CREATED,
    )
}

async fn load_guest_session(
    database: &sqlx::PgPool,
    token: &str,
) -> Result<Option<GuestSessionResponse>, ApiError> {
    let profile = sqlx::query_as::<_, (Uuid, String, String, Uuid)>(
        r#"
        SELECT profiles.id, profiles.display_name, profiles.locale, guest_vaults.id
        FROM user_sessions
        JOIN profiles ON profiles.id = user_sessions.user_id
        JOIN guest_vaults ON guest_vaults.user_id = profiles.id
        WHERE user_sessions.token_hash = $1
          AND user_sessions.revoked_at IS NULL
          AND user_sessions.expires_at > NOW()
        "#,
    )
    .bind(hash_secret(token))
    .fetch_optional(database)
    .await
    .map_err(database_error)?;
    Ok(profile.map(|profile| GuestSessionResponse {
        vault_id: profile.3,
        profile: AuthenticatedProfile {
            id: profile.0,
            display_name: profile.1,
            locale: profile.2,
            email: None,
            account_type: "guest".to_owned(),
            vault_id: Some(profile.3),
        },
    }))
}

fn guest_response(
    payload: GuestSessionResponse,
    token: &str,
    secure_cookies: bool,
    status: StatusCode,
) -> Result<Response, ApiError> {
    let mut response = (status, Json(payload)).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&build_cookie(
            SESSION_COOKIE,
            token,
            "/",
            GUEST_COOKIE_MAX_AGE_SECONDS,
            secure_cookies,
        ))
        .expect("generated guest cookie header must be valid"),
    );
    Ok(response)
}

pub(super) async fn export_guest_vault(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<GuestVaultFile>, ApiError> {
    let user_id = super::authenticated_user_id(&state.database, &headers).await?;
    check_rate_limit(
        &state.redis,
        "guest_vault_export",
        &user_id.to_string(),
        10,
        60,
    )
    .await?;
    let vault_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM guest_vaults WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(&state.database)
        .await
        .map_err(database_error)?
        .ok_or_else(|| ApiError::forbidden("guest_vault_required"))?;
    let recovery_key = format!("{}{}", GUEST_VAULT_RECOVERY_PREFIX, random_token());
    sqlx::query(
        "UPDATE guest_vaults SET recovery_token_hash = $1, last_seen_at = NOW() WHERE id = $2",
    )
    .bind(hash_secret(&recovery_key))
    .bind(vault_id)
    .execute(&state.database)
    .await
    .map_err(database_error)?;
    Ok(Json(GuestVaultFile {
        kind: "slideact.guest_vault",
        version: 1,
        vault_id,
        recovery_key,
    }))
}

pub(super) async fn restore_guest_vault(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RestoreGuestVaultRequest>,
) -> Result<Response, ApiError> {
    check_rate_limit(
        &state.redis,
        "guest_vault_restore",
        &client_network_subject(&headers),
        10,
        60,
    )
    .await?;
    let recovery_key = request.recovery_key.trim();
    if !is_plausible_recovery_key(recovery_key) {
        return Err(ApiError::unauthorized("guest_vault_recovery_invalid"));
    }
    let vault = sqlx::query_as::<_, (Uuid, Uuid, String, String)>(
        r#"
        SELECT guest_vaults.id, profiles.id, profiles.display_name, profiles.locale
        FROM guest_vaults
        JOIN profiles ON profiles.id = guest_vaults.user_id
        WHERE guest_vaults.recovery_token_hash = $1
        "#,
    )
    .bind(hash_secret(recovery_key))
    .fetch_optional(&state.database)
    .await
    .map_err(database_error)?
    .ok_or_else(|| ApiError::unauthorized("guest_vault_recovery_invalid"))?;
    let session_token = persist_guest_session(&state.database, vault.1).await?;
    sqlx::query("UPDATE guest_vaults SET last_seen_at = NOW() WHERE id = $1")
        .bind(vault.0)
        .execute(&state.database)
        .await
        .map_err(database_error)?;
    let secure_cookies = state
        .google_auth
        .as_ref()
        .is_some_and(|auth| auth.0.secure_cookies);
    guest_response(
        GuestSessionResponse {
            vault_id: vault.0,
            profile: AuthenticatedProfile {
                id: vault.1,
                display_name: vault.2,
                locale: vault.3,
                email: None,
                account_type: "guest".to_owned(),
                vault_id: Some(vault.0),
            },
        },
        &session_token,
        secure_cookies,
        StatusCode::OK,
    )
}

async fn persist_guest_session(database: &sqlx::PgPool, user_id: Uuid) -> Result<String, ApiError> {
    let session_token = random_token();
    sqlx::query(
        r#"
        INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, 'infinity'::timestamptz)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(hash_secret(&session_token))
    .execute(database)
    .await
    .map_err(database_error)?;
    Ok(session_token)
}

fn is_plausible_recovery_key(value: &str) -> bool {
    let Some(secret) = value.strip_prefix(GUEST_VAULT_RECOVERY_PREFIX) else {
        return false;
    };
    secret.len() == 43
        && secret
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::super::support::random_token;
    use super::{GUEST_VAULT_RECOVERY_PREFIX, is_plausible_recovery_key};

    #[test]
    fn recovery_keys_must_use_the_issued_prefix_and_token_shape() {
        let valid = format!("{}{}", GUEST_VAULT_RECOVERY_PREFIX, random_token());
        assert!(is_plausible_recovery_key(&valid));
        assert!(!is_plausible_recovery_key("svlt1.short"));
        assert!(!is_plausible_recovery_key(&format!(
            "other.{}",
            random_token()
        )));
        assert!(!is_plausible_recovery_key(&format!("{valid}!")));
    }
}
