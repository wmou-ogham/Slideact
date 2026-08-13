# Performance baseline

The containerized CI suite runs `tests/load/audience.mjs` after functional smoke tests. It creates an isolated Guest Vault, project, understanding cue and live session; then 100 anonymous participants join and submit responses concurrently.

The gate verifies:

- exactly 100 participants are visible in the live view;
- exactly 100 responses are present in the aggregate;
- join and response p95 are each below the intentionally relaxed 5,000 ms threshold.

Baseline on the remote Docker host on 2026-08-13:

| Metric | Result |
| --- | ---: |
| Participants | 100 |
| Concurrent join total | 691 ms |
| Join p95 | 676 ms |
| Concurrent response total | 593 ms |
| Response p95 | 544 ms |
| Final aggregate | 100 |

These numbers are regression indicators rather than a production capacity promise. Network distance, TLS termination, database sizing and host contention are not represented by this single-host Compose run.

Same-CueRun response transactions use a PostgreSQL advisory lock. This deliberately favors correct aggregate and event sequencing over maximum write throughput at the current scale.
