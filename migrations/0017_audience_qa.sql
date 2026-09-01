ALTER TABLE interactions DROP CONSTRAINT interactions_interaction_type_check;

ALTER TABLE interactions
    ADD CONSTRAINT interactions_interaction_type_check
    CHECK (interaction_type IN ('understanding', 'single_choice', 'word_cloud', 'qa', 'audience_qa'));

ALTER TABLE questions
    ADD COLUMN interaction_id UUID REFERENCES interactions (id) ON DELETE CASCADE;

UPDATE questions
SET interaction_id = (
    SELECT interactions.id
    FROM cue_runs
    JOIN interactions ON interactions.cue_id = cue_runs.cue_id
    WHERE cue_runs.id = questions.cue_run_id
      AND interactions.interaction_type = 'qa'
    ORDER BY interactions.position, interactions.id
    LIMIT 1
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM questions WHERE interaction_id IS NULL) THEN
        RAISE EXCEPTION 'cannot assign existing question to an interaction';
    END IF;
END $$;

ALTER TABLE questions ALTER COLUMN interaction_id SET NOT NULL;

CREATE INDEX questions_by_interaction_idx
    ON questions (cue_run_id, interaction_id, status, created_at);
