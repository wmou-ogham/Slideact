\set ON_ERROR_STOP on

BEGIN;

INSERT INTO profiles (id, display_name, locale)
VALUES ('10000000-0000-0000-0000-000000000001', 'Schema Smoke', 'zh-TW');

INSERT INTO oauth_identities (user_id, provider, provider_subject, email, email_verified)
VALUES (
    '10000000-0000-0000-0000-000000000001',
    'google',
    'google-subject-smoke',
    'schema-smoke@example.test',
    TRUE
);

INSERT INTO projects (id, owner_id, title, status, default_locale)
VALUES (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Schema smoke project',
    'active',
    'zh-TW'
);

INSERT INTO project_members (project_id, user_id, role)
VALUES (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'owner'
);

INSERT INTO source_decks (id, project_id, provider, external_id)
VALUES (
    '30000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'google_slides',
    'deck-smoke'
);

INSERT INTO deck_slides (id, deck_id, external_slide_id, last_known_index)
VALUES (
    '31000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'slide-smoke',
    4
);

INSERT INTO cues (id, project_id, position, name, anchor_type, anchor_value)
VALUES (
    '40000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    0,
    'Check understanding',
    'deck_slide',
    'slide-smoke'
);

INSERT INTO interactions (id, cue_id, interaction_type, prompt, settings)
VALUES (
    '41000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    'understanding',
    'Does everyone follow?',
    '{"schema_version":1,"response":{"max_submissions":1}}'
);

INSERT INTO live_sessions (id, project_id, join_code, status, locale, sync_mode)
VALUES (
    '50000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'ABC123',
    'live',
    'zh-TW',
    'auto_connected'
);

INSERT INTO participants (id, session_id, anonymous_key_hash, locale)
VALUES (
    '60000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    DECODE('1234', 'hex'),
    'zh-TW'
);

INSERT INTO cue_runs (id, session_id, cue_id, state)
VALUES (
    '70000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    'open'
);

INSERT INTO responses (
    id,
    cue_run_id,
    interaction_id,
    participant_id,
    idempotency_key,
    payload
)
VALUES (
    '80000000-0000-0000-0000-000000000001',
    '70000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000001',
    'schema-smoke-response',
    '{"choice":"green"}'
);

INSERT INTO session_events (id, session_id, sequence, event_type, state_version, payload)
VALUES (
    '90000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    1,
    'response.accepted',
    1,
    '{"response_id":"80000000-0000-0000-0000-000000000001"}'
);

INSERT INTO outbox_events (id, session_id, topic, event_type, deduplication_key, payload)
VALUES (
    '91000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    'session:50000000-0000-0000-0000-000000000001:presenter',
    'response.accepted',
    'schema-smoke-event',
    '{"sequence":1}'
);

SELECT enqueue_session_event(
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    2,
    2,
    'session:50000000-0000-0000-0000-000000000001:audience',
    '{"event_type":"audience_count_updated","count":12}'
);

DO $$
BEGIN
    BEGIN
        INSERT INTO live_sessions (id, project_id, join_code, status)
        VALUES (
            '50000000-0000-0000-0000-000000000002',
            '20000000-0000-0000-0000-000000000001',
            'ABC123',
            'lobby'
        );
        RAISE EXCEPTION 'active join code uniqueness was not enforced';
    EXCEPTION
        WHEN unique_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO responses (
            id,
            cue_run_id,
            interaction_id,
            participant_id,
            idempotency_key,
            payload
        )
        VALUES (
            '80000000-0000-0000-0000-000000000002',
            '70000000-0000-0000-0000-000000000001',
            '41000000-0000-0000-0000-000000000001',
            '60000000-0000-0000-0000-000000000001',
            'schema-smoke-duplicate-slot',
            '{"choice":"yellow"}'
        );
        RAISE EXCEPTION 'response submission slot uniqueness was not enforced';
    EXCEPTION
        WHEN unique_violation THEN NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM session_events
        WHERE id = '92000000-0000-0000-0000-000000000001'
          AND event_type = 'audience_count_updated'
    ) THEN
        RAISE EXCEPTION 'enqueue_session_event did not persist the session event';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM outbox_events
        WHERE id = '93000000-0000-0000-0000-000000000001'
          AND session_event_id = '92000000-0000-0000-0000-000000000001'
          AND session_sequence = 2
          AND payload ->> 'event_type' = 'audience_count_updated'
          AND payload -> 'event' ->> 'count' = '12'
    ) THEN
        RAISE EXCEPTION 'enqueue_session_event did not persist a coherent outbox envelope';
    END IF;

    BEGIN
        PERFORM enqueue_session_event(
            '92000000-0000-0000-0000-000000000002',
            '93000000-0000-0000-0000-000000000002',
            '50000000-0000-0000-0000-000000000001',
            3,
            3,
            'session:00000000-0000-0000-0000-000000000000:audience',
            '{"event_type":"audience_count_updated","count":13}'
        );
        RAISE EXCEPTION 'cross-session outbox topic was accepted';
    EXCEPTION
        WHEN raise_exception THEN
            IF SQLERRM = 'cross-session outbox topic was accepted' THEN
                RAISE;
            END IF;
    END;
END $$;

ROLLBACK;

SELECT 'core schema smoke test passed' AS result;
