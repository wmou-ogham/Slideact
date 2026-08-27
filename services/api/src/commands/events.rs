use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::api_error::ApiError;

use super::persistence_error;

pub(crate) async fn emit_event_to_all(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    state_version: u64,
    event: Value,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    emit_event_to_topics(
        transaction,
        session_id,
        state_version,
        [
            ("presenter", event.clone()),
            ("audience", event.clone()),
            ("overlay", event),
        ],
        idempotency_key,
    )
    .await
}

pub(crate) async fn emit_event_to_topics(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    state_version: u64,
    events: impl IntoIterator<Item = (&'static str, Value)>,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))")
        .bind(session_id)
        .execute(&mut **transaction)
        .await
        .map_err(persistence_error)?;
    for (audience, event) in events {
        let event_type = event
            .get("event_type")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::internal("event_type_missing"))?;
        let sequence = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE session_id = $1",
        )
        .bind(session_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(persistence_error)?;
        let topic = format!("session:{session_id}:{audience}");
        let deduplication_key =
            format!("command:{session_id}:{idempotency_key}:{event_type}:{audience}");
        sqlx::query("SELECT enqueue_session_event($1, $2, $3, $4, $5, $6, $7, $8)")
            .bind(Uuid::new_v4())
            .bind(Uuid::new_v4())
            .bind(session_id)
            .bind(sequence)
            .bind(i64::try_from(state_version).expect("database state version fits i64"))
            .bind(topic)
            .bind(event)
            .bind(deduplication_key)
            .execute(&mut **transaction)
            .await
            .map_err(persistence_error)?;
    }
    Ok(())
}
