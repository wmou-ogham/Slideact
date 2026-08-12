ALTER TABLE outbox_events
    ADD COLUMN lock_id UUID,
    ADD COLUMN dead_lettered_at TIMESTAMPTZ,
    ADD CONSTRAINT outbox_events_lease_consistency_check
        CHECK ((locked_at IS NULL) = (lock_id IS NULL)),
    ADD CONSTRAINT outbox_events_terminal_state_check
        CHECK (published_at IS NULL OR dead_lettered_at IS NULL);

DROP INDEX outbox_events_dispatch_idx;

CREATE INDEX outbox_events_dispatch_idx
    ON outbox_events (available_at, created_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX outbox_events_dead_letter_idx
    ON outbox_events (dead_lettered_at)
    WHERE dead_lettered_at IS NOT NULL;
