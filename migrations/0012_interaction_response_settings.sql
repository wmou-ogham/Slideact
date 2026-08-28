ALTER TABLE responses
    DROP CONSTRAINT responses_submission_index_check,
    ADD CONSTRAINT responses_submission_index_check
        CHECK (submission_index BETWEEN 0 AND 9);
