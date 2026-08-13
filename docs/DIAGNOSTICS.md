# Diagnostics and client error tracking

The authenticated `/diagnostics` page shows API readiness, PostgreSQL and Redis connectivity, Google OAuth configuration, application/protocol versions, and the current account's 50 most recent client errors.

The Web client reports uncaught errors and unhandled promise rejections only while an application session is present. Reports contain the `web` surface, current route, and a message truncated to 500 characters. The default reporter sends no stack trace, form content, interaction response, question text, email, token, cookie, or browser fingerprint.

Reports are isolated by profile and cascade when the account is deleted. API validation restricts surfaces, field lengths, JSON shape and total context size. Server failures continue to use structured Rust tracing output and container logs; GitHub Actions retains the full CI log artifact for 14 days.
