use std::sync::Arc;

use anyhow::{Context, Result, bail};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use openidconnect::{
    AccessTokenHash, AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    reqwest,
};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{AppState, api_error::ApiError};

use super::{
    DEFAULT_SESSION_TTL_SECONDS, SESSION_COOKIE,
    support::{
        boolean_env, build_cookie, clear_cookie, database_error, duration_env, hash_secret,
        hex_digest, optional_env, random_token, read_cookie, secrets_equal,
    },
};

const GOOGLE_ISSUER: &str = "https://accounts.google.com";
const OAUTH_FLOW_COOKIE: &str = "slide_helper_oauth_flow";
const DEFAULT_FLOW_TTL_SECONDS: u64 = 600;

#[derive(Clone)]
pub(crate) struct GoogleAuth(pub(super) Arc<GoogleAuthInner>);

pub(super) struct GoogleAuthInner {
    client_id: ClientId,
    client_secret: ClientSecret,
    redirect_url: RedirectUrl,
    provider_metadata: CoreProviderMetadata,
    http_client: reqwest::Client,
    flow_ttl_seconds: u64,
    session_ttl_seconds: u64,
    pub(super) secure_cookies: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct AuthStartQuery {
    return_to: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AuthCallbackQuery {
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

pub(super) async fn start_google_auth(
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

pub(super) async fn google_auth_callback(
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

fn sanitize_return_to(value: Option<&str>) -> String {
    value
        .filter(|path| path.starts_with('/') && !path.starts_with("//"))
        .unwrap_or("/")
        .to_owned()
}

fn flow_key(state: &str) -> String {
    format!("auth:google:flow:{}", hex_digest(state))
}

#[cfg(test)]
mod tests {
    use super::sanitize_return_to;

    #[test]
    fn return_path_rejects_absolute_and_scheme_relative_urls() {
        assert_eq!(sanitize_return_to(Some("/projects/123")), "/projects/123");
        assert_eq!(sanitize_return_to(Some("https://attacker.test")), "/");
        assert_eq!(sanitize_return_to(Some("//attacker.test")), "/");
    }
}
