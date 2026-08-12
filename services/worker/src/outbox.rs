use std::{env, time::Duration};

use anyhow::{Context, Result};
use serde_json::Value;
use slide_helper_protocol::{REALTIME_REDIS_CHANNEL, RealtimeEventEnvelope, RealtimePublication};
use sqlx::{FromRow, PgPool};
use tracing::{error, info, warn};
use uuid::Uuid;

const DEFAULT_BATCH_SIZE: i64 = 100;
const DEFAULT_LOCK_TIMEOUT_SECONDS: i64 = 30;
const DEFAULT_MAX_ATTEMPTS: i32 = 10;
const DEFAULT_MAX_BACKOFF_SECONDS: i64 = 300;

#[derive(Debug, Clone, Copy)]
pub(crate) struct DispatcherConfig {
    poll_interval: Duration,
    batch_size: i64,
    lock_timeout_seconds: i64,
    max_attempts: i32,
    max_backoff_seconds: i64,
}

impl DispatcherConfig {
    pub(crate) fn from_env() -> Result<Self> {
        Ok(Self {
            poll_interval: Duration::from_millis(read_positive_env(
                "OUTBOX_POLL_INTERVAL_MS",
                500_u64,
            )?),
            batch_size: read_positive_env("OUTBOX_BATCH_SIZE", DEFAULT_BATCH_SIZE)?,
            lock_timeout_seconds: read_positive_env(
                "OUTBOX_LOCK_TIMEOUT_SECONDS",
                DEFAULT_LOCK_TIMEOUT_SECONDS,
            )?,
            max_attempts: read_positive_env("OUTBOX_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS)?,
            max_backoff_seconds: read_positive_env(
                "OUTBOX_MAX_BACKOFF_SECONDS",
                DEFAULT_MAX_BACKOFF_SECONDS,
            )?,
        })
    }
}

#[derive(Debug, FromRow)]
struct ClaimedEvent {
    id: Uuid,
    topic: String,
    payload: Value,
    attempts: i32,
    lock_id: Uuid,
}

pub(crate) async fn run(database: PgPool, redis: redis::Client, config: DispatcherConfig) {
    loop {
        match dispatch_batch(&database, &redis, config).await {
            Ok(0) => tokio::time::sleep(config.poll_interval).await,
            Ok(count) => info!(count, "outbox batch processed"),
            Err(error) => {
                error!(%error, "outbox dispatcher iteration failed");
                tokio::time::sleep(config.poll_interval).await;
            }
        }
    }
}

async fn dispatch_batch(
    database: &PgPool,
    redis: &redis::Client,
    config: DispatcherConfig,
) -> Result<usize> {
    let mut redis_connection = redis
        .get_multiplexed_async_connection()
        .await
        .context("outbox dispatcher could not connect to Redis")?;
    let events = claim_events(database, config).await?;
    let count = events.len();

    for claimed in events {
        let envelope =
            match serde_json::from_value::<RealtimeEventEnvelope>(claimed.payload.clone()) {
                Ok(envelope) => envelope,
                Err(error) => {
                    mark_failure(
                        database,
                        &claimed,
                        &format!("invalid event envelope: {error}"),
                        true,
                        config,
                    )
                    .await?;
                    continue;
                }
            };
        let publication = RealtimePublication {
            topic: claimed.topic.clone(),
            event: envelope,
        };
        if let Err(error) = publication.validate() {
            mark_failure(database, &claimed, error, true, config).await?;
            continue;
        }
        let encoded = serde_json::to_string(&publication)
            .context("validated realtime publication did not serialize")?;
        let publish_result: redis::RedisResult<i64> = redis::cmd("PUBLISH")
            .arg(REALTIME_REDIS_CHANNEL)
            .arg(encoded)
            .query_async(&mut redis_connection)
            .await;

        match publish_result {
            Ok(subscribers) => {
                mark_published(database, &claimed).await?;
                info!(
                    event_id = %claimed.id,
                    attempts = claimed.attempts,
                    subscribers,
                    "outbox event published"
                );
            }
            Err(error) => {
                warn!(event_id = %claimed.id, %error, "Redis publish failed");
                mark_failure(database, &claimed, &error.to_string(), false, config).await?;
            }
        }
    }

    Ok(count)
}

async fn claim_events(database: &PgPool, config: DispatcherConfig) -> Result<Vec<ClaimedEvent>> {
    let lock_id = Uuid::new_v4();
    sqlx::query_as::<_, ClaimedEvent>(
        r#"
        WITH candidates AS (
            SELECT id
            FROM outbox_events
            WHERE published_at IS NULL
              AND dead_lettered_at IS NULL
              AND available_at <= NOW()
              AND (
                  locked_at IS NULL
                  OR locked_at < NOW() - ($2::BIGINT * INTERVAL '1 second')
              )
            ORDER BY available_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1
        )
        UPDATE outbox_events AS event
        SET lock_id = $3,
            locked_at = NOW(),
            attempts = attempts + 1
        FROM candidates
        WHERE event.id = candidates.id
        RETURNING event.id, event.topic, event.payload, event.attempts, event.lock_id
        "#,
    )
    .bind(config.batch_size)
    .bind(config.lock_timeout_seconds)
    .bind(lock_id)
    .fetch_all(database)
    .await
    .context("failed to claim outbox events")
}

async fn mark_published(database: &PgPool, event: &ClaimedEvent) -> Result<()> {
    let result = sqlx::query(
        r#"
        UPDATE outbox_events
        SET published_at = NOW(), lock_id = NULL, locked_at = NULL, last_error = NULL
        WHERE id = $1 AND lock_id = $2 AND published_at IS NULL
        "#,
    )
    .bind(event.id)
    .bind(event.lock_id)
    .execute(database)
    .await
    .context("failed to mark outbox event as published")?;
    if result.rows_affected() != 1 {
        warn!(event_id = %event.id, "outbox publish lease was lost before acknowledgement");
    }
    Ok(())
}

async fn mark_failure(
    database: &PgPool,
    event: &ClaimedEvent,
    reason: &str,
    permanent: bool,
    config: DispatcherConfig,
) -> Result<()> {
    let should_dead_letter = permanent || event.attempts >= config.max_attempts;
    let exponent = u32::try_from(event.attempts.saturating_sub(1).min(20)).unwrap_or(20);
    let backoff_seconds = 2_i64
        .saturating_pow(exponent)
        .min(config.max_backoff_seconds);
    let result = sqlx::query(
        r#"
        UPDATE outbox_events
        SET lock_id = NULL,
            locked_at = NULL,
            last_error = LEFT($3, 1000),
            available_at = CASE
                WHEN $4 THEN available_at
                ELSE NOW() + ($5::BIGINT * INTERVAL '1 second')
            END,
            dead_lettered_at = CASE WHEN $4 THEN NOW() ELSE NULL END
        WHERE id = $1 AND lock_id = $2 AND published_at IS NULL
        "#,
    )
    .bind(event.id)
    .bind(event.lock_id)
    .bind(reason)
    .bind(should_dead_letter)
    .bind(backoff_seconds)
    .execute(database)
    .await
    .context("failed to record outbox delivery failure")?;
    if result.rows_affected() != 1 {
        warn!(event_id = %event.id, "outbox publish lease was lost while recording failure");
    } else if should_dead_letter {
        error!(event_id = %event.id, attempts = event.attempts, reason, "outbox event dead-lettered");
    }
    Ok(())
}

fn read_positive_env<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr + PartialOrd + From<u8> + Copy + std::fmt::Display,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    let value = match env::var(name) {
        Ok(raw) => raw
            .parse::<T>()
            .with_context(|| format!("invalid {name} value {raw}"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("failed to read {name}")),
    };
    if value <= T::from(0) {
        anyhow::bail!("{name} must be positive, got {value}");
    }
    Ok(value)
}
