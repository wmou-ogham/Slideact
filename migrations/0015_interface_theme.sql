ALTER TABLE live_sessions
    ADD COLUMN interface_theme TEXT NOT NULL DEFAULT 'lively'
        CHECK (interface_theme IN ('classic', 'lively', 'terminal'));
