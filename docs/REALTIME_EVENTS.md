# Realtime events and transactional outbox

## Delivery path

State-changing handlers must update the authoritative rows and call
`enqueue_session_event(...)` in the same PostgreSQL transaction. The function
persists both `session_events` and a versioned `outbox_events` envelope. The
Worker leases committed outbox rows, publishes them to Redis Pub/Sub, and only
then records `published_at`. Every API instance validates Redis messages before
forwarding them to its local WebSocket clients.

```text
HTTP command transaction
  -> domain state + session_events + outbox_events
  -> Worker lease
  -> Redis Pub/Sub
  -> API instance broadcast channel
  -> authorized topic subscriber
```

PostgreSQL remains authoritative. Redis is only the low-latency fan-out layer.

## Delivery semantics

- Delivery is **at least once**. A Worker can publish and stop before recording
  `published_at`, so clients must deduplicate by `event_id` or by the monotonic
  `(session_id, sequence)` pair.
- Temporary delivery failures use exponential backoff. Invalid envelopes and
  rows that exhaust the configured attempt limit are dead-lettered for
  inspection rather than retried forever.
- A UUID lease prevents a stale Worker from acknowledging a row reclaimed by a
  different Worker after the lock timeout.
- `after_sequence` on the WebSocket subscribe message replays up to 500 matching
  persisted topic events. `snapshot_required` means the client must fetch a
  state snapshot before subscribing again from its new sequence.
- A lagged in-memory subscriber receives `event_gap` and must recover from a
  snapshot/replay. Event receipt alone is not a command acknowledgement.

## Event envelope

Protocol v2 uses `ServerMessage::Event` with schema version 1. The outer
envelope contains `event_id`, `session_id`, `sequence`, `state_version`,
`occurred_at`, and a discriminator duplicated as `event_type`. The nested event
is a generated tagged union shared by Rust and TypeScript.

Topic authorization remains independent of the event type:

- `session:{id}:presenter`
- `session:{id}:audience`
- `session:{id}:overlay`

The database function, Worker, API Redis subscriber, replay loader, and
WebSocket actor all validate that the topic belongs to the same session.

## Worker configuration

| Variable | Default | Purpose |
|---|---:|---|
| `OUTBOX_POLL_INTERVAL_MS` | `500` | Idle/error polling interval |
| `OUTBOX_BATCH_SIZE` | `100` | Rows claimed per iteration |
| `OUTBOX_LOCK_TIMEOUT_SECONDS` | `30` | Lease recovery timeout |
| `OUTBOX_MAX_ATTEMPTS` | `10` | Attempts before dead-letter |
| `OUTBOX_MAX_BACKOFF_SECONDS` | `300` | Retry backoff ceiling |
