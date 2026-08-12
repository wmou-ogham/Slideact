\set ON_ERROR_STOP on

INSERT INTO profiles (id, display_name, locale)
VALUES
    ('a0000000-0000-0000-0000-000000000001', 'CI Owner', 'en'),
    ('a0000000-0000-0000-0000-000000000002', 'CI Stranger', 'en');

INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
VALUES
    (
        'a1000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000001',
        sha256(convert_to('ci-owner-session', 'UTF8')),
        NOW() + INTERVAL '1 hour'
    ),
    (
        'a1000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000002',
        sha256(convert_to('ci-stranger-session', 'UTF8')),
        NOW() + INTERVAL '1 hour'
    );

INSERT INTO projects (id, owner_id, title, status, default_locale)
VALUES (
    'a2000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'Authorization smoke project',
    'active',
    'en'
);

INSERT INTO project_members (project_id, user_id, role)
VALUES (
    'a2000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'owner'
);

INSERT INTO live_sessions (id, project_id, join_code, status, locale, sync_mode)
VALUES (
    'a5000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'AUTH01',
    'live',
    'en',
    'manual'
);

SELECT 'authorization smoke fixture created' AS result;
