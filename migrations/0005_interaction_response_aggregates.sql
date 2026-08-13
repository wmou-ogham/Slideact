ALTER TABLE responses
    ADD COLUMN interaction_id UUID REFERENCES interactions (id) ON DELETE CASCADE;

UPDATE responses
SET interaction_id = matching.interaction_id
FROM (
    SELECT responses.id AS response_id,
           (ARRAY_AGG(interactions.id ORDER BY interactions.position, interactions.id))[1]
               AS interaction_id
    FROM responses
    JOIN cue_runs ON cue_runs.id = responses.cue_run_id
    JOIN interactions ON interactions.cue_id = cue_runs.cue_id
    GROUP BY responses.id
) AS matching
WHERE responses.id = matching.response_id;

ALTER TABLE responses
    ALTER COLUMN interaction_id SET NOT NULL,
    DROP CONSTRAINT responses_cue_run_id_participant_id_submission_index_key,
    DROP CONSTRAINT responses_cue_run_id_participant_id_idempotency_key_key,
    ADD CONSTRAINT responses_interaction_submission_slot_key
        UNIQUE (cue_run_id, interaction_id, participant_id, submission_index),
    ADD CONSTRAINT responses_interaction_idempotency_key
        UNIQUE (cue_run_id, interaction_id, participant_id, idempotency_key);

CREATE INDEX responses_by_interaction_idx
    ON responses (cue_run_id, interaction_id, submitted_at);

ALTER TABLE response_aggregates
    ADD COLUMN interaction_id UUID REFERENCES interactions (id) ON DELETE CASCADE;

UPDATE response_aggregates
SET interaction_id = matching.interaction_id
FROM (
    SELECT response_aggregates.cue_run_id,
           (ARRAY_AGG(interactions.id ORDER BY interactions.position, interactions.id))[1]
               AS interaction_id
    FROM response_aggregates
    JOIN cue_runs ON cue_runs.id = response_aggregates.cue_run_id
    JOIN interactions ON interactions.cue_id = cue_runs.cue_id
    GROUP BY response_aggregates.cue_run_id
) AS matching
WHERE response_aggregates.cue_run_id = matching.cue_run_id;

ALTER TABLE response_aggregates
    DROP CONSTRAINT response_aggregates_pkey,
    ALTER COLUMN interaction_id SET NOT NULL,
    ADD PRIMARY KEY (cue_run_id, interaction_id);
