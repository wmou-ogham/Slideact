use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use slide_helper_protocol::{
    REALTIME_REDIS_CHANNEL, RealtimeEventEnvelope, RealtimePublication, ServerMessage,
};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tracing::{info, warn};
use uuid::Uuid;

const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_REPLAY_EVENTS: i64 = 500;

pub(crate) async fn run_subscriber(
    redis: redis::Client,
    room_tx: broadcast::Sender<ServerMessage>,
) {
    loop {
        if let Err(error) = subscribe_once(&redis, &room_tx).await {
            warn!(%error, "realtime Redis subscriber disconnected");
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

async fn subscribe_once(
    redis: &redis::Client,
    room_tx: &broadcast::Sender<ServerMessage>,
) -> anyhow::Result<()> {
    let mut pubsub = redis.get_async_pubsub().await?;
    pubsub.subscribe(REALTIME_REDIS_CHANNEL).await?;
    info!(
        channel = REALTIME_REDIS_CHANNEL,
        "realtime Redis subscriber ready"
    );
    let mut messages = pubsub.on_message();

    while let Some(message) = messages.next().await {
        let payload: String = match message.get_payload() {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "realtime Redis message was not UTF-8 text");
                continue;
            }
        };
        let publication = match serde_json::from_str::<RealtimePublication>(&payload) {
            Ok(publication) => publication,
            Err(error) => {
                warn!(%error, "realtime Redis message had an invalid envelope");
                continue;
            }
        };
        if let Err(error) = publication.validate() {
            warn!(error, "realtime Redis publication failed validation");
            continue;
        }
        let _ = room_tx.send(ServerMessage::Event {
            topic: publication.topic,
            event: publication.event,
        });
    }
    anyhow::bail!("Redis Pub/Sub stream ended")
}

pub(crate) async fn replay_events(
    database: &PgPool,
    session_id: Uuid,
    topic: &str,
    after_sequence: u64,
) -> Result<Vec<ServerMessage>, &'static str> {
    let after_sequence = i64::try_from(after_sequence).map_err(|_| "snapshot_required")?;
    let payloads = sqlx::query_scalar::<_, Value>(
        r#"
        SELECT payload
        FROM outbox_events
        WHERE session_id = $1
          AND topic = $2
          AND session_sequence > $3
          AND dead_lettered_at IS NULL
        ORDER BY session_sequence, created_at
        LIMIT $4
        "#,
    )
    .bind(session_id)
    .bind(topic)
    .bind(after_sequence)
    .bind(MAX_REPLAY_EVENTS + 1)
    .fetch_all(database)
    .await
    .map_err(|error| {
        warn!(%error, %session_id, topic, "failed to load realtime replay");
        "event_replay_failed"
    })?;
    if i64::try_from(payloads.len()).unwrap_or(i64::MAX) > MAX_REPLAY_EVENTS {
        return Err("snapshot_required");
    }

    payloads
        .into_iter()
        .map(|payload| {
            let event =
                serde_json::from_value::<RealtimeEventEnvelope>(payload).map_err(|error| {
                    warn!(%error, %session_id, topic, "persisted realtime event was invalid");
                    "event_replay_failed"
                })?;
            let publication = RealtimePublication {
                topic: topic.to_owned(),
                event,
            };
            publication.validate().map_err(|error| {
                warn!(error, %session_id, topic, "persisted realtime event failed validation");
                "event_replay_failed"
            })?;
            Ok(ServerMessage::Event {
                topic: publication.topic,
                event: publication.event,
            })
        })
        .collect()
}
