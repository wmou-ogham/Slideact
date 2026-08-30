ALTER TABLE responses
    ALTER COLUMN submission_index TYPE BIGINT,
    DROP CONSTRAINT responses_submission_index_check,
    ADD CONSTRAINT responses_submission_index_check
        CHECK (submission_index >= 0);
