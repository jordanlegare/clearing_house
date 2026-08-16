# Canadian Philanthropy Clearing House

A **ChatGPT plugin-compatible MCP app/backend plus recipient self-service clearing layer** for routing Canadian foundation disbursement capacity toward registered charities and other eligible recipients with less application overhead and stronger auditability.

The project combines public **CRA T3010 / List of charities** data from Open Government Canada with an opt-in authenticated grant workflow, an autonomous operations worker, and a no-account recipient offer portal.

## What works now

### Public discovery and T3010 ingestion

- Discover and stream the current CRA T3010 CSV resources from Open Government Canada's CKAN catalogue.
- Normalize identification, financials, programs, qualified/non-qualified donees, foundations, Schedule 8 DQ, and web-address data.
- Search/fetch charities and foundations and match foundation filing evidence to candidate recipients with transparent reasons.
- Model DQ/capital scenarios and administrative-capacity savings.
- Refresh T3010 automatically through the durable worker when `ENABLE_T3010_SYNC=1`.

### Foundation allocation planning

- Build deterministic budget-to-recipient portfolios from transparent T3010 matching evidence.
- Enforce explicit budget, minimum/maximum grant, maximum-recipient, province, focus, score and purpose constraints.
- Keep monetary math in integer cents and reject sub-cent grant values.
- Report unallocated capital instead of inventing recipients or breaking caps.
- Bind foundation, purpose and cent-denominated allocations with a SHA-256 integrity hash. The hash is an integrity check, **not approval evidence**.
- Materialize an explicitly supplied plan into idempotent **draft grants only** after revalidating every BN against the loaded registered-charity dataset.

### Authenticated grant workflow

With `ENABLE_WORKFLOW_WRITES=1`, PostgreSQL + OIDC/OAuth + encryption/audit keys configured:

- organization-scoped RBAC;
- recipient and foundation profile claims against loaded T3010 records;
- controlled system-admin verification and role assignment;
- grant draft/proposal/approval/offer/acceptance lifecycle;
- proposer/approver separation;
- proportional non-qualified-donee diligence with separate review;
- current CRA status observations for release gating;
- independent compliance review;
- encrypted external banking-verification references;
- two-person manual-payment intent/authorization separation;
- external payment-reference recording;
- T3010/T1441 reporting-package preparation;
- idempotent writes and HMAC-chained audit records.

**The app cannot execute a bank transfer.** Payment remains an externally executed/manual operation that the clearing house can authorize and record.

### No-account recipient experience

With `RECIPIENT_PORTAL_ENABLED=1`:

1. a foundation approves and offers a grant;
2. the notification worker generates or reuses one single-use capability link immediately before delivery;
3. the random bearer secret is stored only as a SHA-256 lookup hash plus application-layer ciphertext;
4. the recipient receives an SMS/voice notification saying that no grant application is required;
5. the recipient opens the secure browser link, reviews the amount, purpose and versioned terms, and chooses **Accept** or **Decline**;
6. acceptance/decline is written atomically to the grant state, versioned consent record, grant event and HMAC audit chain;
7. the capability is consumed and cannot be reused.

The recipient does **not** need a ChatGPT account or clearing-house login merely to respond to a grant offer.

The portal sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, CSP, frame-deny and content-type protections. Terms are rendered as escaped text, not trusted HTML.

### Autonomous operations

The worker uses PostgreSQL-backed schedules, expiring leases and heartbeats so multiple replicas can compete safely and crashed workers do not permanently strand jobs. It currently handles:

- T3010/Open Canada refresh;
- notification dispatch and retry;
- secure recipient-link issuance at notification time;
- stale notification-lock recovery;
- expired offer-capability retirement;
- stale worker-heartbeat cleanup.

The autonomous layer handles plumbing. It does **not** silently approve grants, certify NQD diligence, invent authoritative CRA status, authorize its own payment, execute transfers, or claim CRA accepted a filing.

## ChatGPT compatibility

This repository implements the MCP app/backend used by a ChatGPT custom app/plugin. Deploy the MCP endpoint to public HTTPS, configure OAuth/OIDC, scan `/mcp` in ChatGPT developer tooling, test permissions/write confirmations, and publish through the applicable ChatGPT app/plugin workflow.

When OAuth is used, configure refresh tokens / `offline_access`; otherwise the app can lose authenticated connectivity when the original access token expires.

Protected-resource metadata is published at:

```text
/.well-known/oauth-protected-resource
```

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

Apply migrations in lexical order:

```bash
for migration in db/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

Current migrations cover core persistence, authenticated workflow runtime, diligence/payment/offer-token extensions, autonomous scheduling, and secure recipient self-service.

## Recipient portal

Development example:

```bash
RECIPIENT_PORTAL_ENABLED=1 \
RECIPIENT_PORTAL_BASE_URL=http://localhost:3001 \
RECIPIENT_PORTAL_PORT=3001 \
DATABASE_URL=postgres://... \
ENCRYPTION_KEY='<32+ chars>' \
AUDIT_HMAC_KEY='<32+ chars>' \
npm run portal
```

Production requires an HTTPS `RECIPIENT_PORTAL_BASE_URL`. Capability TTL defaults to seven days and is bounded to 30 days.

Docker Compose exposes the portal through an explicit profile so it cannot accidentally start without its secrets:

```bash
docker compose --profile recipient-portal up -d
```

Set `RECIPIENT_PORTAL_ENABLED=1` for the worker too, so outgoing grant-offer notifications receive secure response links.

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

## Notifications

Configure Twilio and run the autonomous worker:

```bash
NOTIFICATION_PROVIDER=twilio \
TWILIO_ACCOUNT_SID=... \
TWILIO_AUTH_TOKEN=... \
TWILIO_FROM_NUMBER=... \
AUTOMATION_ENABLED=1 \
npm run ops:worker
```

Notification destinations and reusable offer secrets are encrypted at rest. The model does not receive arbitrary direct-message capability.

## MCP tools

Public read-only tools include:

`dataset_status`, `search`, `fetch`, `search_charities`, `search_foundations`, `get_foundation_dq_record`, `match_foundation_recipients`, `calculate_foundation_dq`, `model_foundation_capital`, `national_allocation_scenario`, `estimate_admin_capacity_saved`, `open_canada_catalogue`, plus optional `sync_t3010`.

Authenticated workflow mode additionally includes the identity/grant tools plus:

- `build_allocation_portfolio`
- `create_portfolio_drafts`
- `check_cra_public_evidence`
- `prepare_nqd_diligence`
- `get_nqd_diligence`
- `approve_nqd_diligence`
- `record_banking_verification`
- `create_manual_payment_intent`
- payment/reporting workflow actions.

## Safety boundaries

- T3010 data is public/self-reported filing data, not a live legal-status guarantee.
- Matching and portfolio planning are discovery/allocation support, not awards or CRA determinations.
- Portfolio materialization creates drafts only.
- Retrieved text never determines authorization.
- Foundation roles are organization scoped.
- Recipient acceptance is explicit and versioned, whether authenticated or through a single-use capability.
- Payment authorization requires current authoritative status evidence, compliance approval, verified banking evidence and operator separation.
- No bank credentials or transfer API are present in the baseline implementation.
- CRA reporting records are review artifacts; the app does not submit returns or claim acceptance.

See `docs/WORKFLOW.md`, `docs/PRODUCTION_REQUIREMENTS.md`, `docs/THREAT_MODEL.md`, `docs/OPERATIONS.md`, `docs/T3010.md`, and `PRIVACY.md`.
