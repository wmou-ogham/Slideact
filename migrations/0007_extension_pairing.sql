CREATE TABLE extension_pairing_codes (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
    code_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    redeemed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at),
    CHECK (redeemed_at IS NULL OR redeemed_at >= created_at)
);

CREATE INDEX extension_pairing_codes_active_idx
    ON extension_pairing_codes (expires_at)
    WHERE redeemed_at IS NULL;

CREATE TABLE presentation_bindings (
    session_id UUID PRIMARY KEY REFERENCES live_sessions (id) ON DELETE CASCADE,
    deck_id TEXT NOT NULL CHECK (BTRIM(deck_id) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX presentation_bindings_deck_idx
    ON presentation_bindings (deck_id, session_id);
