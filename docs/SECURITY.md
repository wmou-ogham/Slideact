# Security controls

Slideact applies server-side authorization, validation, and fixed-window rate limits before accepting audience writes. Redis stores only a SHA-256-derived subject key and the current counter; raw network addresses are not written to rate-limit keys or application logs.

## Audience limits

| Operation | Scope | Limit |
| --- | --- | ---: |
| Join | Network + join code | 300 / 60 seconds |
| Interaction response | Participant | 20 / 60 seconds |
| Create Q&A question | Participant | 5 / 60 seconds |
| Toggle Q&A vote | Participant | 120 / 60 seconds |
| Presenter command | Session + presenter | 120 / 60 seconds |

The join allowance intentionally supports the documented 100-person baseline from one venue network. Exceeding a limit returns HTTP `429` with `rate_limit_exceeded`; the bilingual audience client asks the participant to wait and retry.

## Text protections

- Word-cloud entries collapse whitespace, convert full-width ASCII, and use lowercase aggregation so equivalent words share a bucket.
- Word-cloud entries with excessive repeated characters or multiple links are rejected.
- Q&A questions collapse whitespace and reject excessive repeated characters or more than two links.
- User-provided free text and bearer tokens are never included in structured error logs.

These controls are deliberately basic abuse prevention for the beta. A production internet deployment should put an additional edge rate limiter and bot-management policy in front of the proxy.
