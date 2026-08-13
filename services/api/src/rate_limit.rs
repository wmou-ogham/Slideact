use axum::http::HeaderMap;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::api_error::ApiError;

pub(crate) async fn check(
    redis: &redis::Client,
    bucket: &str,
    subject: &str,
    limit: i64,
    window_seconds: i64,
) -> Result<(), ApiError> {
    let digest = Sha256::digest(subject.as_bytes());
    let key = format!("slideact:rate:{bucket}:{}", URL_SAFE_NO_PAD.encode(digest));
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .map_err(redis_error)?;
    let count: i64 = redis::Script::new(
        r#"
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then
            redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return count
        "#,
    )
    .key(key)
    .arg(window_seconds)
    .invoke_async(&mut connection)
    .await
    .map_err(redis_error)?;
    if count > limit {
        return Err(ApiError::too_many_requests("rate_limit_exceeded"));
    }
    Ok(())
}

pub(crate) fn client_network_subject(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("unknown-client")
        .to_owned()
}

fn redis_error(error: redis::RedisError) -> ApiError {
    warn!(%error, "rate limiter Redis operation failed");
    ApiError::unavailable("rate_limiter_unavailable")
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::client_network_subject;

    #[test]
    fn first_forwarded_address_is_used_as_the_network_subject() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.5, 10.0.0.2"),
        );
        assert_eq!(client_network_subject(&headers), "203.0.113.5");
    }
}
