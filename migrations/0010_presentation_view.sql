ALTER TABLE live_sessions
    ADD COLUMN presentation_view TEXT NOT NULL DEFAULT 'join_qr'
        CHECK (presentation_view IN ('join_qr', 'cue'));

UPDATE live_sessions
SET presentation_view = 'cue'
WHERE current_cue_run_id IS NOT NULL;
