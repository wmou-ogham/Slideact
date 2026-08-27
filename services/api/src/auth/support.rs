use std::env;

use anyhow::{Context, Result, bail};
use axum::http::{HeaderMap, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::api_error::ApiError;

pub(super) fn database_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "authentication database operation failed");
    ApiError::internal("auth_persistence_failed")
}

pub(super) fn read_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|entry| entry.trim().split_once('='))
        .find_map(|(cookie_name, value)| (cookie_name == name).then_some(value))
}

pub(super) fn build_cookie(
    name: &str,
    value: &str,
    path: &str,
    max_age_seconds: u64,
    secure: bool,
) -> String {
    format!(
        "{name}={value}; Path={path}; HttpOnly; SameSite=Lax; Max-Age={max_age_seconds}{}",
        if secure { "; Secure" } else { "" }
    )
}

pub(super) fn clear_cookie(name: &str, path: &str, secure: bool) -> String {
    format!(
        "{name}=; Path={path}; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

pub(super) fn validate_locale(locale: &str) -> Result<(), ApiError> {
    if matches!(locale, "en" | "zh-TW") {
        Ok(())
    } else {
        Err(ApiError::bad_request("locale_invalid"))
    }
}

pub(super) fn secrets_equal(left: &str, right: &str) -> bool {
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

pub(super) fn hex_digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

pub(super) fn duration_env(name: &str, default: u64) -> Result<u64> {
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

pub(super) fn boolean_env(name: &str, default: bool) -> Result<bool> {
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

    use super::super::SESSION_COOKIE;
    use super::{build_cookie, hash_secret, random_token, read_cookie, secrets_equal};

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
