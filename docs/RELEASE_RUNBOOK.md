# Production Release and Recovery Runbook

This runbook defines the operational contract for an unattended clearing-house deployment. It supplements `PRODUCTION_REQUIREMENTS.md`, `OPERATIONS.md`, and `THREAT_MODEL.md`.

## 1. Non-negotiable release invariants

A release is not production-ready unless all of these are true:

1. Protected `main` contains the exact release commit.
2. Required GitHub checks passed on that commit.
3. `npm run readiness` has no blockers under the production environment.
4. All SQL migrations completed successfully.
5. `npm run schema:check` reports `ready: true`.
6. The API, autonomous worker, and recipient portal use the same database/schema generation.
7. Encryption and audit-HMAC keys come from a secret manager, not repository files.
8. Workflow writes use authenticated OIDC identities and organization-scoped roles.
9. Notification credentials are production credentials when recipient delivery is enabled.
10. Payment execution remains external/manual unless a separately reviewed payment implementation is introduced later.

Do not bypass these gates to restore service. Restore a known-good version or disable the affected feature instead.

## 2. Startup order

The supported deployment order is:

```text
PostgreSQL healthy
      ↓
SQL migrations
      ↓
schema readiness check
      ↓
API + autonomous worker
      ↓
optional recipient portal
```

The Docker Compose topology encodes this order. The API additionally runs the schema gate before loading the MCP server whenever a database is configured. The worker always runs the schema gate before claiming jobs.

A schema failure is a deployment failure, not a condition for the worker to retry indefinitely.

## 3. Autonomous worker lease model

Every autonomous job uses a database lease. Claims are selected with `FOR UPDATE SKIP LOCKED`, so concurrent workers cannot normally claim the same due row.

While a job runs, its worker renews the lease approximately every one-third of the configured lease duration, capped at one minute between renewals. Completion is accepted only while the same worker still owns an unexpired lease.

If a worker crashes:

- its heartbeat becomes stale;
- its job lease eventually expires;
- another worker may reclaim the due job;
- stale notification locks are released by the maintenance job;
- idempotency keys and state-machine guards must absorb safe retries.

If a worker loses a lease while still executing, it is not allowed to mark that job complete. Treat repeated lease loss as an incident: investigate database latency, worker pauses, or an undersized `AUTOMATION_LEASE_SECONDS`.

## 4. Kill switches

Use the narrowest switch that contains the incident:

| Incident | Immediate action |
|---|---|
| Identity/RBAC uncertainty | `ENABLE_WORKFLOW_WRITES=0` |
| Autonomous-policy anomaly | `AUTOMATED_PORTFOLIOS_ENABLED=0` |
| Worker-wide anomaly | `AUTOMATION_ENABLED=0` |
| Notification misrouting/provider issue | `NOTIFICATION_PROVIDER=disabled` |
| Website-contact crawler concern | `WEBSITE_CONTACT_ENRICHMENT_ENABLED=0` |
| Recipient portal capability-link concern | `RECIPIENT_PORTAL_ENABLED=0` and revoke affected tokens |
| Payment-control concern | `PAYMENT_PROVIDER=disabled` and stop external payment processing |
| T3010/Open Canada anomaly | `ENABLE_T3010_SYNC=0`; retain the last known-good manifest |

Disabling automation must not be used to bypass approval, compliance, recipient-consent, status-verification, or payment-separation controls.

## 5. Data-source failure behavior

### Open Canada / T3010

Public-data refresh failure must leave the last known-good local snapshot intact. Do not replace a valid snapshot with a partial ingest. The operational status tool should surface failed/overdue refresh jobs.

### Recipient website enrichment

Website enrichment is best-effort and bounded. No website result is legal or organizational verification. A discovered phone number is only an encrypted candidate and must prove channel control before an offer is sent.

If enrichment fails or a site disallows crawling, leave the grant in `pending_contact`. Never guess or infer a destination.

## 6. Notification failure behavior

Notification outbox delivery is retryable and idempotent. Provider failures must not roll back grant approval or recipient consent state.

If the provider is degraded:

1. disable the provider or automation if misdelivery is possible;
2. preserve queued outbox rows;
3. inspect attempts/errors and provider message IDs;
4. restore the provider;
5. allow the normal dispatcher to retry queued rows.

Never bulk-rewrite encrypted recipient destinations to force a retry.

## 7. Database backup and restore

Private workflow state is backup-critical. T3010 public data can be re-ingested; grants, approvals, audit records, recipient consent, contact verification, diligence, payment references, and reporting records cannot.

Production requirements:

- automated encrypted backups;
- point-in-time recovery where supported;
- restore credentials separated from application credentials;
- periodic restore drills into an isolated environment;
- independently retained audit-log export/checkpoints;
- retention aligned with applicable Canadian books-and-records requirements and the configured policy.

After any restore:

1. keep workflow writes and automation disabled;
2. run migrations;
3. run `npm run schema:check`;
4. reconcile the audit-chain tail and external payment references;
5. verify the restored timestamp against notification/provider and CRA filing records;
6. only then re-enable workflow writes and automation.

## 8. Release sequence

For each production release:

```bash
npm install
npm run check
npm test
npm run readiness
# migrate target database
npm run schema:check
```

Then deploy the exact protected-main commit. Start one worker first, confirm heartbeats/job health through `operational_status`, then scale workers if needed. Multiple workers are supported by database leases; scaling does not remove the need for external service rate limits.

## 9. Post-release verification

Verify:

- API health endpoint responds;
- MCP client can negotiate and list tools;
- unauthenticated protected MCP requests receive 401;
- `operational_status` shows loaded T3010 data;
- at least one current worker heartbeat exists when automation is enabled;
- no automation job is unexpectedly failed/overdue;
- recipient portal health responds when enabled;
- no unexpected pending payment or reporting backlog appeared during deployment.

Do not create a real-money smoke grant to validate deployment.

## 10. Incident evidence

Preserve before destructive remediation:

- release/commit SHA;
- runtime configuration excluding secret values;
- operational-status snapshot;
- automation job/heartbeat rows;
- relevant audit-log chain segment;
- provider message/payment references;
- T3010 manifest revision;
- affected grant IDs and state transitions.

For a suspected security incident, rotate affected credentials only after preserving the evidence required to reconcile what happened.
