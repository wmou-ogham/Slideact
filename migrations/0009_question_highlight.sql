ALTER TABLE questions DROP CONSTRAINT questions_status_check;

ALTER TABLE questions
    ADD CONSTRAINT questions_status_check
    CHECK (status IN ('pending', 'visible', 'answered', 'hidden', 'pinned', 'highlighted'));
