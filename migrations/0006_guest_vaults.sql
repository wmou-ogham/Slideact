CREATE TABLE guest_vaults (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES profiles (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (last_seen_at >= created_at)
);

CREATE INDEX guest_vaults_by_last_seen_idx ON guest_vaults (last_seen_at DESC);
