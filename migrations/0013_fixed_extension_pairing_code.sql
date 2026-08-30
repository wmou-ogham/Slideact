ALTER TABLE extension_pairing_codes
    ADD COLUMN code TEXT,
    ADD CONSTRAINT extension_pairing_codes_code_format_check
        CHECK (code IS NULL OR code ~ '^[2-9A-HJKMNP-Z]{8}$');

CREATE UNIQUE INDEX extension_pairing_codes_session_code_idx
    ON extension_pairing_codes (session_id)
    WHERE code IS NOT NULL;

CREATE UNIQUE INDEX extension_pairing_codes_plain_code_idx
    ON extension_pairing_codes (code)
    WHERE code IS NOT NULL;
