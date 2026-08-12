use std::{env, sync::Arc};

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openidconnect::{
    AccessTokenHash, AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    reqwest,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{AppState, api_error::ApiError};

const GOOGLE_ISSUER: &str = "https://accounts.google.com";
const OAUTH_FLOW_COOKIE: &str = "slide_helper_oauth_flow";
const SESSION_COOKIE: &str = "slide_helper_session";
const DEFAULT_FLOW_TTL_SECONDS: u64 = 600;
const DEFAULT_SESSION_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone)]
pub(crate) struct GoogleAuth(Arc<GoogleAuthInner>);

struct GoogleAuthInner {
    client_id: ClientId,
    client_secret: ClientSecret,
    redirect_url: RedirectUrl,
    provider_metadata: CoreProviderMetadata,
    http_client: reqwest::Client,
    flow_ttl_seconds: u64,
    session_ttl_seconds: u64,
    secure_cookies: bool,
}

#[derive(Debug, Deserialize)]
struct AuthStartQuery {
    return_to: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    iss: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingAuthFlow {
    nonce: String,
    pkce_verifier: String,
    return_to: String,
}

#[derive(Debug, Serialize)]
struct AuthenticatedProfile {
    id: Uuid,
    display_name: String,
    locale: String,
    email: Option<String>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/google/start", get(start_google_auth))
        .route("/api/auth/google/callback", get(google_auth_callback))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
}

impl GoogleAuth {
    pub(crate) async fn from_env() -> Result<Option<Self>> {
        let client_id = optional_env("GOOGLE_OAUTH_CLIENT_ID");
        let client_secret = optional_env("GOOGLE_OAUTH_CLIENT_SECRET");
        let redirect_url = optional_env("GOOGLE_OAUTH_REDIRECT_URL");

        let (client_id, client_secret, redirect_url) = match (
            client_id,
            client_secret,
            redirect_url,
        ) {
            (None, None, None) => {
                info!("Google OpenID Connect is not configured");
                return Ok(None);
            }
            (Some(client_id), Some(client_secret), Some(redirect_url)) => {
                (client_id, client_secret, redirect_url)
            }
            _ => bail!(
                "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URL must be set together"
            ),
        };

        let http_client = reqwest::ClientBuilder::new()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("failed to build OIDC HTTP client")?;
        let provider_metadata = CoreProviderMetadata::discover_async(
            IssuerUrl::new(GOOGLE_ISSUER.to_owned()).context("invalid Google issuer")?,
            &http_client,
        )
        .await
        .context("Google OIDC discovery failed")?;

        Ok(Some(Self(Arc::new(GoogleAuthInner {
            client_id: ClientId::new(client_id),
            client_secret: ClientSecret::new(client_secret),
            redirect_url: RedirectUrl::new(redirect_url)
                .context("invalid Google OAuth redirect URL")?,
            provider_metadata,
            http_client,
            flow_ttl_seconds: duration_env("AUTH_FLOW_TTL_SECONDS", DEFAULT_FLOW_TTL_SECONDS)?,
            session_ttl_seconds: duration_env(
                "AUTH_SESSION_TTL_SECONDS",
                DEFAULT_SESSION_TTL_SECONDS,
            )?,
            secure_cookies: boolean_env("AUTH_COOKIE_SECURE", true)?,
        }))))
    }
}

async fn start_google_auth(
    State(state): State<AppState>,
    Query(query): Query<AuthStartQuery>,
) -> Result<Response, ApiError> {
    let auth = state
        .google_auth
        .as_ref()
        .ok_or_else(|| ApiError::unavailable("auth_not_configured"))?;
    let client = CoreClient::from_provider_metadata(
        auth.0.provider_metadata.clone(),
        auth.0.client_id.clone(),
        Some(auth.0.client_secret.clone()),
    )
    .set_redirect_uri(auth.0.redirect_url.clone());
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let (authorization_url, csrf_token, nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("openid".to_owned()))
        .add_scope(Scope::new("email".to_owned()))
        .add_scope(Scope::new("profile".to_owned()))
        .set_pkce_challenge(pkce_challenge)
        .url();

    let flow = PendingAuthFlow {
        nonce: nonce.secret().to_owned(),
        pkce_verifier: pkce_verifier.secret().to_owned(),
        return_to: sanitize_return_to(query.return_to.as_deref()),
    };
    store_pending_flow(
        &state.redis,
        csrf_token.secret(),
        &flow,
        auth.0.flow_ttl_seconds,
    )
    .await?;

    let flow_cookie = build_cookie(
        OAUTH_FLOW_COOKIE,
        csrf_token.secret(),
        "/api/auth/google/callback",
        auth.0.flow_ttl_seconds,
        auth.0.secure_cookies,
    );
    redirect_response(authorization_url.as_str(), &[flow_cookie])
}

async fn google_auth_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AuthCallbackQuery>,
) -> Result<Response, ApiError> {
    let auth = state
        .google_auth
        .as_ref()
        .ok_or_else(|| ApiError::unavailable("auth_not_configured"))?;
    let returned_state = query
        .state
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("auth_state_missing"))?;
    let cookie_state = read_cookie(&headers, OAUTH_FLOW_COOKIE)
        .ok_or_else(|| ApiError::unauthorized("auth_flow_cookie_missing"))?;
    if !secrets_equal(returned_state, cookie_state) {
        return Err(ApiError::unauthorized("auth_state_mismatch"));
    }
    if query
        .iss
        .as_deref()
        .is_some_and(|issuer| issuer != GOOGLE_ISSUER)
    {
        return Err(ApiError::unauthorized("auth_issuer_mismatch"));
    }

    let flow = take_pending_flow(&state.redis, returned_state).await?;
    if query.error.is_some() {
        return Err(ApiError::unauthorized("auth_provider_rejected"));
    }
    let code = query
        .code
        .ok_or_else(|| ApiError::bad_request("auth_code_missing"))?;
    let client = CoreClient::from_provider_metadata(
        auth.0.provider_metadata.clone(),
        auth.0.client_id.clone(),
        Some(auth.0.client_secret.clone()),
    )
    .set_redirect_uri(auth.0.redirect_url.clone());
    let token_response = client
        .exchange_code(AuthorizationCode::new(code))
        .map_err(|error| {
            warn!(%error, "Google token endpoint is unavailable in discovered metadata");
            ApiError::gateway("auth_exchange_failed")
        })?
        .set_pkce_verifier(PkceCodeVerifier::new(flow.pkce_verifier))
        .request_async(&auth.0.http_client)
        .await
        .map_err(|error| {
            warn!(%error, "Google authorization code exchange failed");
            ApiError::gateway("auth_exchange_failed")
        })?;

    let id_token = token_response.id_token().ok_or_else(|| {
        warn!("Google token response did not include an ID token");
        ApiError::gateway("auth_id_token_missing")
    })?;
    let id_token_verifier = client.id_token_verifier();
    let nonce = Nonce::new(flow.nonce);
    let claims = id_token
        .claims(&id_token_verifier, &nonce)
        .map_err(|error| {
            warn!(%error, "Google ID token verification failed");
            ApiError::unauthorized("auth_id_token_invalid")
        })?;

    if let Some(expected_hash) = claims.access_token_hash() {
        let actual_hash = AccessTokenHash::from_token(
            token_response.access_token(),
            id_token.signing_alg().map_err(|error| {
                warn!(%error, "Google ID token has no supported signing algorithm");
                ApiError::unauthorized("auth_id_token_invalid")
            })?,
            id_token.signing_key(&id_token_verifier).map_err(|error| {
                warn!(%error, "Google ID token signing key was not found");
                ApiError::unauthorized("auth_id_token_invalid")
            })?,
        )
        .map_err(|error| {
            warn!(%error, "Google access token hash verification failed");
            ApiError::unauthorized("auth_access_token_invalid")
        })?;
        if actual_hash != *expected_hash {
            return Err(ApiError::unauthorized("auth_access_token_invalid"));
        }
    }

    let subject = claims.subject().as_str();
    let email = claims.email().map(|value| value.as_str());
    let display_name = claims
        .name()
        .and_then(|localized| localized.get(None))
        .map_or_else(|| email.unwrap_or("Google User"), |value| value.as_str());
    let session_token = persist_login(
        &state.database,
        subject,
        email,
        claims.email_verified().unwrap_or(false),
        display_name,
        auth.0.session_ttl_seconds,
    )
    .await?;

    let session_cookie = build_cookie(
        SESSION_COOKIE,
        &session_token,
        "/",
        auth.0.session_ttl_seconds,
        auth.0.secure_cookies,
    );
    let clear_flow_cookie = clear_cookie(
        OAUTH_FLOW_COOKIE,
        "/api/auth/google/callback",
        auth.0.secure_cookies,
    );
    redirect_response(&flow.return_to, &[session_cookie, clear_flow_cookie])
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AuthenticatedProfile>, ApiError> {
    let token = read_cookie(&headers, SESSION_COOKIE)
        .ok_or_else(|| ApiError::unauthorized("authentication_required"))?;
    let token_hash = hash_secret(token);
    let profile = sqlx::query_as::<_, (Uuid, String, String, Option<String>)>(
        r#"
        SELECT profiles.id, profiles.display_name, profiles.locale, oauth_identities.email
        FROM user_sessions
        JOIN profiles ON profiles.id = user_sessions.user_id
        LEFT JOIN oauth_identities
          ON oauth_identities.user_id = profiles.id AND oauth_identities.provider = 'google'
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
    }))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
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

async fn store_pending_flow(
    redis: &redis::Client,
    state: &str,
    flow: &PendingAuthFlow,
    ttl_seconds: u64,
) -> Result<(), ApiError> {
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| {
            warn!(%error, "failed to connect to Redis for OAuth flow");
            ApiError::internal("auth_flow_store_failed")
        })?;
    let payload = serde_json::to_string(flow).expect("pending OAuth flow must serialize");
    let stored: Option<String> = redis::cmd("SET")
        .arg(flow_key(state))
        .arg(payload)
        .arg("EX")
        .arg(ttl_seconds)
        .arg("NX")
        .query_async(&mut connection)
        .await
        .map_err(|error| {
            warn!(%error, "failed to store OAuth flow");
            ApiError::internal("auth_flow_store_failed")
        })?;
    if stored.is_none() {
        return Err(ApiError::internal("auth_flow_collision"));
    }
    Ok(())
}

async fn take_pending_flow(
    redis: &redis::Client,
    state: &str,
) -> Result<PendingAuthFlow, ApiError> {
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| {
            warn!(%error, "failed to connect to Redis for OAuth callback");
            ApiError::internal("auth_flow_lookup_failed")
        })?;
    let payload: Option<String> = redis::cmd("GETDEL")
        .arg(flow_key(state))
        .query_async(&mut connection)
        .await
        .map_err(|error| {
            warn!(%error, "failed to consume OAuth flow");
            ApiError::internal("auth_flow_lookup_failed")
        })?;
    let payload = payload.ok_or_else(|| ApiError::unauthorized("auth_flow_expired"))?;
    serde_json::from_str(&payload).map_err(|error| {
        warn!(%error, "stored OAuth flow is invalid");
        ApiError::internal("auth_flow_invalid")
    })
}

async fn persist_login(
    database: &sqlx::PgPool,
    subject: &str,
    email: Option<&str>,
    email_verified: bool,
    display_name: &str,
    session_ttl_seconds: u64,
) -> Result<String, ApiError> {
    let mut transaction = database.begin().await.map_err(database_error)?;
    let user_id = find_or_create_google_user(
        &mut transaction,
        subject,
        email,
        email_verified,
        display_name,
    )
    .await?;
    let session_token = random_token();
    let session_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, NOW() + ($4::BIGINT * INTERVAL '1 second'))
        "#,
    )
    .bind(session_id)
    .bind(user_id)
    .bind(hash_secret(&session_token))
    .bind(session_ttl_seconds as i64)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    info!(%user_id, %session_id, "application session created from Google OIDC");
    Ok(session_token)
}

async fn find_or_create_google_user(
    transaction: &mut Transaction<'_, Postgres>,
    subject: &str,
    email: Option<&str>,
    email_verified: bool,
    display_name: &str,
) -> Result<Uuid, ApiError> {
    // A missing identity row cannot be locked with SELECT ... FOR UPDATE. Serialize
    // first-login transactions by Google subject so concurrent callbacks cannot
    // create duplicate profiles before the unique identity constraint is visible.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(subject)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;

    if let Some(user_id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM oauth_identities WHERE provider = 'google' AND provider_subject = $1 FOR UPDATE",
    )
    .bind(subject)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(database_error)?
    {
        sqlx::query(
            r#"
            UPDATE oauth_identities
            SET email = $2, email_verified = $3, updated_at = NOW()
            WHERE provider = 'google' AND provider_subject = $1
            "#,
        )
        .bind(subject)
        .bind(email)
        .bind(email_verified)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
        return Ok(user_id);
    }

    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO profiles (id, display_name, locale) VALUES ($1, $2, 'en')")
        .bind(user_id)
        .bind(display_name)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    sqlx::query(
        r#"
        INSERT INTO oauth_identities (
            user_id,
            provider,
            provider_subject,
            email,
            email_verified
        )
        VALUES ($1, 'google', $2, $3, $4)
        "#,
    )
    .bind(user_id)
    .bind(subject)
    .bind(email)
    .bind(email_verified)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(user_id)
}

fn database_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "authentication database operation failed");
    ApiError::internal("auth_persistence_failed")
}

fn redirect_response(location: &str, cookies: &[String]) -> Result<Response, ApiError> {
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(location).map_err(|_| ApiError::internal("auth_redirect_invalid"))?,
    );
    for cookie in cookies {
        response.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_str(cookie).map_err(|_| ApiError::internal("auth_cookie_invalid"))?,
        );
    }
    Ok(response)
}

fn read_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|entry| entry.trim().split_once('='))
        .find_map(|(cookie_name, value)| (cookie_name == name).then_some(value))
}

fn build_cookie(name: &str, value: &str, path: &str, max_age_seconds: u64, secure: bool) -> String {
    format!(
        "{name}={value}; Path={path}; HttpOnly; SameSite=Lax; Max-Age={max_age_seconds}{}",
        if secure { "; Secure" } else { "" }
    )
}

fn clear_cookie(name: &str, path: &str, secure: bool) -> String {
    format!(
        "{name}=; Path={path}; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

fn sanitize_return_to(value: Option<&str>) -> String {
    value
        .filter(|path| path.starts_with('/') && !path.starts_with("//"))
        .unwrap_or("/")
        .to_owned()
}

fn secrets_equal(left: &str, right: &str) -> bool {
    hash_secret(left) == hash_secret(right)
}

pub(crate) fn hash_secret(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

pub(crate) fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn flow_key(state: &str) -> String {
    format!("auth:google:flow:{}", hex_digest(state))
}

fn hex_digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn duration_env(name: &str, default: u64) -> Result<u64> {
    let Some(value) = optional_env(name) else {
        return Ok(default);
    };
    let duration = value
        .parse::<u64>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if duration == 0 {
        bail!("{name} must be greater than zero");
    }
    Ok(duration)
}

fn boolean_env(name: &str, default: bool) -> Result<bool> {
    let Some(value) = optional_env(name) else {
        return Ok(default);
    };
    match value.as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => bail!("{name} must be true, false, 1, or 0"),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, header};

    use super::{
        SESSION_COOKIE, build_cookie, hash_secret, random_token, read_cookie, sanitize_return_to,
        secrets_equal,
    };

    #[test]
    fn return_path_rejects_absolute_and_scheme_relative_urls() {
        assert_eq!(sanitize_return_to(Some("/projects/123")), "/projects/123");
        assert_eq!(sanitize_return_to(Some("https://attacker.test")), "/");
        assert_eq!(sanitize_return_to(Some("//attacker.test")), "/");
    }

    #[test]
    fn cookie_reader_matches_the_exact_cookie_name() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=x; slide_helper_session=secret; trailing=y"),
        );

        assert_eq!(read_cookie(&headers, SESSION_COOKIE), Some("secret"));
        assert_eq!(read_cookie(&headers, "session"), None);
    }

    #[test]
    fn secure_cookie_has_expected_browser_protections() {
        let cookie = build_cookie(SESSION_COOKIE, "token", "/", 60, true);

        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("Max-Age=60"));
    }

    #[test]
    fn secret_comparison_uses_fixed_length_hashes() {
        assert!(secrets_equal("same", "same"));
        assert!(!secrets_equal("same", "different"));
        assert_eq!(hash_secret("value").len(), 32);
    }

    #[test]
    fn session_tokens_have_256_bits_of_url_safe_random_input() {
        let first = random_token();
        let second = random_token();

        assert_eq!(first.len(), 43);
        assert_ne!(first, second);
        assert!(
            first.chars().all(
                |character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            )
        );
    }
}
