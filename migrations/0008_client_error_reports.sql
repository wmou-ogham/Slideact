CREATE TABLE client_error_reports (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    surface TEXT NOT NULL CHECK (surface IN ('web', 'extension')),
    route TEXT NOT NULL CHECK (BTRIM(route) <> ''),
    message TEXT NOT NULL CHECK (BTRIM(message) <> ''),
    context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (JSONB_TYPEOF(context) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX client_error_reports_by_user_idx
    ON client_error_reports (user_id, created_at DESC);
