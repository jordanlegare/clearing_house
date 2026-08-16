# Operations Runbook Requirements

## Deployment gates

Run:

```bash
npm run readiness
npm run check
npm test
```

A production deployment with workflow writes must not proceed while `npm run readiness` reports blockers.

## Required external services for write workflows

- PostgreSQL-compatible primary database with backups/PITR
- OIDC/OAuth provider capable of refresh/offline access for ChatGPT connectivity
- Secret manager/KMS for encryption and audit integrity keys
- Current recipient-status verification process/source
- Notification provider if SMS/email/voice delivery is enabled
- External payment process or later approved payment provider

## Backup and recovery

- Automated database backups and point-in-time recovery
- Restore drill at least quarterly during initial production year
- Audit-log export stored separately from the primary database
- T3010 public data can be re-ingested; private workflow state cannot be reconstructed from Open Canada and is therefore backup-critical

## Incident response

Immediately disable `ENABLE_WORKFLOW_WRITES` if identity, authorization, audit integrity or payment controls are suspected compromised. Preserve logs, rotate affected credentials, reconcile all grants/payment references since the last known-good checkpoint, and notify affected organizations/regulators when required.

## Data refresh

Run T3010 ingestion on a controlled schedule and retain the manifest for every published dataset revision. Do not overwrite the provenance needed to explain which public filing data supported a prior match.
