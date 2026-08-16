# Canadian Philanthropy Clearing House

A **ChatGPT plugin-compatible MCP app/backend** for routing Canadian foundation disbursement capacity toward registered charities and other eligible recipients with less application overhead and stronger auditability.

The project combines public **CRA T3010 / List of charities** data from Open Government Canada with an opt-in authenticated grant workflow.

## What works now

### Public discovery

- Discover and stream the current CRA T3010 CSV resources from Open Government Canada's CKAN catalogue.
- Normalize identification, financials, programs, qualified/non-qualified donees, foundations, Schedule 8 DQ, and web-address data.
- Search/fetch charities and foundations and match foundation filing evidence to candidate recipients with transparent reasons.
- Model DQ/capital scenarios and administrative-capacity savings.

### Authenticated workflow

With `ENABLE_WORKFLOW_WRITES=1`, PostgreSQL + OIDC/OAuth + encryption/audit keys configured:

- organization-scoped RBAC;
- recipient and foundation profile claims against loaded T3010 records;
- controlled system-admin verification and role assignment;
- grant draft/proposal/approval/offer/acceptance lifecycle;
- versioned recipient consent;
- current CRA List-of-Charities status observations for release gating;
- independent compliance review;
- manual/external payment authorization and payment-reference recording;
- encrypted SMS/voice notification outbox with Twilio worker support;
- T3010/T1441 reporting-package preparation;
- idempotent writes and HMAC-chained audit records.

**The app still cannot execute a bank transfer.** Payment remains an externally executed/manual operation that the clearing house can authorize and record.

## ChatGPT compatibility

This repository implements the MCP app/backend used by a ChatGPT custom app/plugin. Deploy it to a remotely reachable HTTPS endpoint, configure OAuth/OIDC, scan the `/mcp` tools in ChatGPT developer mode, test the write actions, and publish only after workspace review.

When OAuth is used, configure the provider for refresh tokens / `offline_access`; otherwise ChatGPT can lose connectivity after the original access token expires.

The server publishes protected-resource metadata at:

```text
/.well-known/oauth-protected-resource
```

and returns a bearer authentication challenge when authenticated workflow mode is enabled.

## Quick start

```bash
npm install
npm test
npm run readiness
npm run ingest:t3010 -- --year 2024
npm start
```

Public MCP endpoint:

```text
http://localhost:3000/mcp
```

## Database

Apply migrations in order:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_core.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_workflow_runtime.sql
```

The CI suite applies both migrations against PostgreSQL 16 and runs an end-to-end workflow smoke.

## Bootstrap the first administrator

The first global administrator is an operator bootstrap, not an AI action:

```bash
DATABASE_URL=postgres://... \
BOOTSTRAP_ADMIN_SUBJECT='<exact OIDC sub>' \
BOOTSTRAP_ADMIN_EMAIL='admin@example.ca' \
npm run bootstrap:admin
```

In production also provide:

```text
BOOTSTRAP_ADMIN_CONFIRM=BOOTSTRAP <exact OIDC sub>
```

After that, organization claims and role grants can be handled through authenticated MCP tools.

## Notification worker

Grant offers may queue `sms` or `voice` notifications. Destinations are encrypted in PostgreSQL. Configure Twilio and run the worker from a scheduler/queue runner:

```bash
NOTIFICATION_PROVIDER=twilio \
TWILIO_ACCOUNT_SID=... \
TWILIO_AUTH_TOKEN=... \
TWILIO_FROM_NUMBER=... \
npm run dispatch:notifications
```

The worker uses row locking to avoid two workers claiming the same queued message. The model does not get arbitrary direct-message capability.

## MCP tools

Public tools remain available in read-only mode:

`dataset_status`, `search`, `fetch`, `search_charities`, `search_foundations`, `get_foundation_dq_record`, `match_foundation_recipients`, `calculate_foundation_dq`, `model_foundation_capital`, `national_allocation_scenario`, `estimate_admin_capacity_saved`, `open_canada_catalogue`, plus optional `sync_t3010`.

Authenticated workflow mode adds:

`workflow_whoami`, `workflow_list_grants`, `workflow_get_grant`, `claim_recipient_organization`, `claim_foundation_organization`, `verify_organization_claim`, `grant_organization_role`, `create_grant`, `propose_grant`, `approve_grant`, `offer_grant`, `accept_grant`, `decline_grant`, `record_cra_status_verification`, `review_grant_compliance`, `authorize_manual_payment`, `record_manual_payment`, `prepare_reporting_record`, and `mark_grant_reported`.

## Safety boundaries

- T3010 data is public/self-reported filing data, not a live legal-status guarantee.
- Matching is discovery, not an award or CRA determination.
- Retrieved text never determines authorization.
- Foundation roles are organization scoped.
- Proposer/approver separation is enforced server-side.
- Recipient acceptance is explicit and versioned.
- Payment authorization requires current authoritative status evidence and compliance approval.
- Notification addresses/numbers are encrypted at rest in the application layer.
- No banking credentials or transfer API are present in the baseline implementation.
- CRA reporting records are review artifacts; the app does not submit returns or claim acceptance.

See [docs/WORKFLOW.md](docs/WORKFLOW.md), [docs/PRODUCTION_REQUIREMENTS.md](docs/PRODUCTION_REQUIREMENTS.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/T3010.md](docs/T3010.md), and [PRIVACY.md](PRIVACY.md).
