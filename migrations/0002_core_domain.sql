CREATE TABLE profiles (
    id UUID PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (BTRIM(display_name) <> ''),
    locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'zh-TW')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE oauth_identities (
    user_id UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google')),
    provider_subject TEXT NOT NULL CHECK (BTRIM(provider_subject) <> ''),
    email TEXT,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, provider_subject),
    UNIQUE (user_id, provider)
);

CREATE TABLE user_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX user_sessions_active_by_user_idx
    ON user_sessions (user_id, expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE projects (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (BTRIM(title) <> ''),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
    default_locale TEXT NOT NULL DEFAULT 'en' CHECK (default_locale IN ('en', 'zh-TW')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX projects_by_owner_idx ON projects (owner_id, updated_at DESC);

CREATE TABLE project_members (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'presenter')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE source_decks (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google_slides')),
    external_id TEXT NOT NULL CHECK (BTRIM(external_id) <> ''),
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, provider, external_id)
);

CREATE TABLE deck_slides (
    id UUID PRIMARY KEY,
    deck_id UUID NOT NULL REFERENCES source_decks (id) ON DELETE CASCADE,
    external_slide_id TEXT NOT NULL CHECK (BTRIM(external_slide_id) <> ''),
    last_known_index INTEGER CHECK (last_known_index IS NULL OR last_known_index >= 0),
    title TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (deck_id, external_slide_id)
);

CREATE TABLE cues (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
    anchor_type TEXT NOT NULL CHECK (anchor_type IN ('deck_slide', 'manual')),
    anchor_value TEXT,
    trigger_mode TEXT NOT NULL DEFAULT 'presenter_confirm'
        CHECK (trigger_mode IN ('immediate', 'delay', 'presenter_confirm')),
    delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (delay_seconds >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, position),
    CHECK (
        (anchor_type = 'deck_slide' AND anchor_value IS NOT NULL AND BTRIM(anchor_value) <> '')
        OR (anchor_type = 'manual' AND anchor_value IS NULL)
    ),
    CHECK ((trigger_mode = 'delay' AND delay_seconds > 0) OR trigger_mode <> 'delay')
);

CREATE TABLE interactions (
    id UUID PRIMARY KEY,
    cue_id UUID NOT NULL REFERENCES cues (id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    interaction_type TEXT NOT NULL
        CHECK (interaction_type IN ('understanding', 'single_choice', 'word_cloud', 'qa')),
    prompt TEXT NOT NULL CHECK (BTRIM(prompt) <> ''),
    description TEXT,
    settings JSONB NOT NULL DEFAULT '{"schema_version":1}'::jsonb
        CHECK (JSONB_TYPEOF(settings) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cue_id, position)
);

CREATE TABLE interaction_options (
    id UUID PRIMARY KEY,
    interaction_id UUID NOT NULL REFERENCES interactions (id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    label TEXT NOT NULL CHECK (BTRIM(label) <> ''),
    is_correct BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (interaction_id, position)
);

CREATE TABLE live_sessions (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    join_code CHAR(6),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'lobby', 'live', 'paused', 'ended')),
    locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'zh-TW')),
    sync_mode TEXT NOT NULL DEFAULT 'manual'
        CHECK (sync_mode IN (
            'auto_connected',
            'auto_paused',
            'manual',
            'disconnected',
            'resync_required'
        )),
    state_version BIGINT NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    CHECK (join_code IS NULL OR join_code ~ '^[A-Z0-9]{6}$'),
    CHECK (status NOT IN ('lobby', 'live', 'paused') OR join_code IS NOT NULL),
    CHECK (ended_at IS NULL OR started_at IS NOT NULL),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX live_sessions_active_join_code_idx
    ON live_sessions (join_code)
    WHERE status IN ('lobby', 'live', 'paused');

CREATE INDEX live_sessions_by_project_idx ON live_sessions (project_id, created_at DESC);

CREATE TABLE session_tokens (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
    role TEXT NOT NULL
        CHECK (role IN ('owner', 'presenter', 'controller', 'audience', 'overlay', 'extension')),
    token_hash BYTEA NOT NULL UNIQUE,
    resource_scope JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (JSONB_TYPEOF(resource_scope) = 'object'),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX session_tokens_active_idx
    ON session_tokens (session_id, role, expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE participants (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
    anonymous_key_hash BYTEA NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'zh-TW')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, anonymous_key_hash),
    CHECK (last_seen_at >= joined_at)
);

CREATE TABLE cue_runs (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
    cue_id UUID NOT NULL REFERENCES cues (id) ON DELETE RESTRICT,
    run_number INTEGER NOT NULL DEFAULT 1 CHECK (run_number > 0),
    state TEXT NOT NULL DEFAULT 'idle'
        CHECK (state IN ('idle', 'ready', 'open', 'closed', 'revealed', 'skipped')),
    state_version BIGINT NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    revealed_at TIMESTAMPTZ,
    UNIQUE (session_id, cue_id, run_number),
    CHECK (closed_at IS NULL OR opened_at IS NOT NULL),
    CHECK (revealed_at IS NULL OR closed_at IS NOT NULL),
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
    CHECK (revealed_at IS NULL OR revealed_at >= closed_at)
);

ALTER TABLE live_sessions
    ADD COLUMN current_cue_run_id UUID REFERENCES cue_runs (id) ON DELETE SET NULL;

CREATE TABLE responses (
    id UUID PRIMARY KEY,
    cue_run_id UUID NOT NULL REFERENCES cue_runs (id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
    submission_index SMALLINT NOT NULL DEFAULT 0 CHECK (submission_index BETWEEN 0 AND 2),
    idempotency_key TEXT NOT NULL CHECK (BTRIM(idempotency_key) <> ''),
    payload JSONB NOT NULL CHECK (JSONB_TYPEOF(payload) = 'object'),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cue_run_id, participant_id, submission_index),
    UNIQUE (cue_run_id, participant_id, idempotency_key)
);

CREATE INDEX responses_by_cue_run_idx ON responses (cue_run_id, submitted_at);

CREATE TABLE response_aggregates (
    cue_run_id UUID PRIMARY KEY REFERENCES cue_runs (id) ON DELETE CASCADE,
    aggregate JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (JSONB_TYPEOF(aggregate) = 'object'),
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE questions (
    id UUID PRIMARY KEY,
    cue_run_id UUID NOT NULL REFERENCES cue_runs (id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (BTRIM(body) <> ''),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'visible', 'answered', 'hidden', 'pinned')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX questions_by_cue_run_idx ON questions (cue_run_id, status, created_at);

CREATE TABLE question_votes (
    question_id UUID NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (question_id, participant_id)
);

CREATE TABLE session_events (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    event_type TEXT NOT NULL CHECK (BTRIM(event_type) <> ''),
    state_version BIGINT NOT NULL CHECK (state_version >= 0),
    payload JSONB NOT NULL CHECK (JSONB_TYPEOF(payload) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, sequence)
);

CREATE TABLE command_receipts (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
    actor_scope TEXT NOT NULL CHECK (BTRIM(actor_scope) <> ''),
    idempotency_key TEXT NOT NULL CHECK (BTRIM(idempotency_key) <> ''),
    expected_version BIGINT NOT NULL CHECK (expected_version >= 0),
    resulting_version BIGINT CHECK (resulting_version IS NULL OR resulting_version >= 0),
    result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (JSONB_TYPEOF(result) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, actor_scope, idempotency_key)
);

CREATE TABLE controller_connections (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
    controller_type TEXT NOT NULL
        CHECK (controller_type IN ('extension', 'presenter_console', 'presenter_remote', 'obs_dock')),
    connection_key TEXT NOT NULL CHECK (BTRIM(connection_key) <> ''),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (JSONB_TYPEOF(metadata) = 'object'),
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disconnected_at TIMESTAMPTZ,
    UNIQUE (session_id, controller_type, connection_key),
    CHECK (heartbeat_at >= connected_at),
    CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
);

ALTER TABLE outbox_events
    ADD COLUMN session_id UUID REFERENCES live_sessions (id) ON DELETE CASCADE,
    ADD COLUMN event_type TEXT NOT NULL DEFAULT 'legacy.broadcast',
    ADD COLUMN deduplication_key TEXT,
    ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN locked_at TIMESTAMPTZ,
    ADD COLUMN last_error TEXT;

CREATE UNIQUE INDEX outbox_events_deduplication_idx
    ON outbox_events (deduplication_key)
    WHERE deduplication_key IS NOT NULL;

CREATE INDEX outbox_events_dispatch_idx
    ON outbox_events (available_at, created_at)
    WHERE published_at IS NULL;
