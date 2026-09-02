ALTER TABLE participants
ADD COLUMN display_name TEXT
CHECK (
    display_name IS NULL
    OR (CHAR_LENGTH(BTRIM(display_name)) BETWEEN 1 AND 40)
);
