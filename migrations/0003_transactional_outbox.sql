ALTER TABLE outbox_events
    ADD COLUMN session_event_id UUID REFERENCES session_events (id) ON DELETE CASCADE,
    ADD COLUMN session_sequence BIGINT CHECK (session_sequence > 0);

CREATE UNIQUE INDEX outbox_events_session_event_topic_idx
    ON outbox_events (session_event_id, topic)
    WHERE session_event_id IS NOT NULL;

CREATE INDEX outbox_events_replay_idx
    ON outbox_events (session_id, topic, session_sequence)
    WHERE session_event_id IS NOT NULL;

ALTER TABLE outbox_events
    ADD CONSTRAINT outbox_events_envelope_consistency_check CHECK (
        session_event_id IS NULL
        OR (
            session_id IS NOT NULL
            AND session_sequence IS NOT NULL
            AND payload ->> 'schema_version' = '1'
            AND payload ->> 'event_id' = session_event_id::TEXT
            AND payload ->> 'session_id' = session_id::TEXT
            AND (payload ->> 'sequence')::BIGINT = session_sequence
            AND payload ->> 'event_type' = event_type
            AND JSONB_TYPEOF(payload -> 'event') = 'object'
            AND payload -> 'event' ->> 'event_type' = event_type
        )
    );

CREATE OR REPLACE FUNCTION enqueue_session_event(
    p_event_id UUID,
    p_outbox_id UUID,
    p_session_id UUID,
    p_sequence BIGINT,
    p_state_version BIGINT,
    p_topic TEXT,
    p_event JSONB,
    p_deduplication_key TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_event_type TEXT;
    v_occurred_at TIMESTAMPTZ;
BEGIN
    IF p_sequence <= 0 THEN
        RAISE EXCEPTION 'session event sequence must be positive';
    END IF;

    IF p_state_version < 0 THEN
        RAISE EXCEPTION 'session event state version cannot be negative';
    END IF;

    IF JSONB_TYPEOF(p_event) <> 'object' THEN
        RAISE EXCEPTION 'session event must be a JSON object';
    END IF;

    v_event_type := p_event ->> 'event_type';
    IF v_event_type IS NULL OR BTRIM(v_event_type) = '' THEN
        RAISE EXCEPTION 'session event must contain event_type';
    END IF;

    IF p_topic NOT IN (
        FORMAT('session:%s:presenter', p_session_id),
        FORMAT('session:%s:audience', p_session_id),
        FORMAT('session:%s:overlay', p_session_id)
    ) THEN
        RAISE EXCEPTION 'topic does not belong to session %', p_session_id;
    END IF;

    INSERT INTO session_events (
        id,
        session_id,
        sequence,
        event_type,
        state_version,
        payload
    )
    VALUES (
        p_event_id,
        p_session_id,
        p_sequence,
        v_event_type,
        p_state_version,
        p_event
    )
    RETURNING occurred_at INTO v_occurred_at;

    INSERT INTO outbox_events (
        id,
        session_id,
        session_event_id,
        session_sequence,
        topic,
        event_type,
        deduplication_key,
        payload
    )
    VALUES (
        p_outbox_id,
        p_session_id,
        p_event_id,
        p_sequence,
        p_topic,
        v_event_type,
        COALESCE(
            NULLIF(BTRIM(p_deduplication_key), ''),
            FORMAT('session-event:%s:%s', p_event_id, p_topic)
        ),
        JSONB_BUILD_OBJECT(
            'schema_version', 1,
            'event_id', p_event_id,
            'session_id', p_session_id,
            'sequence', p_sequence,
            'state_version', p_state_version,
            'occurred_at', v_occurred_at,
            'event_type', v_event_type,
            'event', p_event
        )
    );
END;
$$;
