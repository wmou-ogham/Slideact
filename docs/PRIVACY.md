# Privacy and data deletion

Slideact stores the minimum data required to run presenter projects and live audience interactions.

## Data categories

- Google accounts: provider subject, verified email when supplied by Google, display name and locale.
- Guest Vaults: random profile and Vault UUIDs; no email or real name is required. The browser keeps a long-lived HttpOnly session cookie.
- Presentations: projects, cues, interaction content, live-session state and scoped controller tokens.
- Audience: a random per-session participant identifier, locale, responses, questions and votes. Audience names and email addresses are not collected.
- Extension diagnostics: random device UUID, Google deck/slide identifiers, last position, heartbeat time and the last short transport error.

Raw pairing codes and bearer tokens are never stored; the database stores SHA-256 hashes. CSV exports include only the anonymous per-session participant UUID.

## Account deletion

The presenter profile menu exposes **Delete account**. After an explicit destructive confirmation, the API deletes all projects owned by that account inside one database transaction. Foreign-key cascades remove cues, interactions, sessions, participants, responses, questions, votes, events, controller diagnostics, extension pairings and tokens. It then deletes the profile, Google identity or Guest Vault, and every application session before clearing the browser cookie.

Deletion cannot be undone. Shared projects owned by another account are retained, while the deleted profile's membership is removed.

## Operational backups

This development deployment does not configure off-host backups. A production operator must document backup encryption, retention and deletion propagation before accepting real audience data.
