# Autonomous operations

The clearing house can run as a persistent API plus a separate worker process. The worker is deliberately responsible for operational repetition, not fiduciary or legal discretion.

## What runs without an operator

When `AUTOMATION_ENABLED=1`, the worker persists job schedules and leases in PostgreSQL. Multiple worker replicas can run safely because due jobs are claimed with row locks and expiring leases.

The baseline autonomous jobs are:

- **notifications** — claims encrypted queued notifications, sends them through the configured provider, retries transient failures up to the existing delivery limit, and leaves an audit trail;
- **t3010_sync** — refreshes the configured CRA T3010/Open Government dataset on a durable schedule when `ENABLE_T3010_SYNC=1`;
- **maintenance** — recovers abandoned notification locks, retires long-expired browser-offer tokens, and removes obsolete worker heartbeats.

The MCP server periodically reloads the shared T3010 data directory, so a completed worker refresh becomes visible without manually restarting the API.

## What remains intentionally gated

Autonomy does **not** collapse the separation-of-duties controls. The worker does not:

- approve a foundation grant;
- certify a non-qualified-donee diligence file;
- invent or record an authoritative CRA eligibility decision;
- authorize its own payment intent;
- execute a bank transfer;
- claim that a CRA filing was submitted or accepted.

Those are consequential external decisions or actions and remain attributable to authorized actors or external systems.

## One-command local deployment

`docker compose up -d --build` starts PostgreSQL, applies every migration, starts the MCP API, and starts the autonomous worker against a shared T3010 data volume. With default settings it continuously refreshes public data and maintains the operational queue while authenticated grant writes and payments remain disabled.

For production, set HTTPS `PUBLIC_BASE_URL`, production OIDC values, secret-manager-backed `ENCRYPTION_KEY` and `AUDIT_HMAC_KEY`, and whichever notification provider is used. `npm run readiness` remains the fail-closed deployment gate.

## Worker commands

- `npm run ops:worker` — long-running scheduler/worker.
- `npm run ops:once` — claim and execute one due-job batch; used by CI and useful for cron/serverless operation.

The scheduler stores last start/completion/status/error/result for each job and a heartbeat for each active worker. A crashed worker's job lease expires and another worker can safely claim the work.
