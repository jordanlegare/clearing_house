# Canadian Philanthropy Clearing House

A **ChatGPT plugin-compatible MCP app/backend** for turning Canadian foundation disbursement capacity into discoverable, auditable grant workflows with far less repeated application/admin work for recipient organizations.

The system ingests public **CRA T3010 List of charities** data from Open Government Canada, exposes transparent foundation/recipient discovery through MCP, and can optionally enable authenticated PostgreSQL-backed grant workflows.

## What works now

### Public discovery

- discover current CRA T3010 CSV resources from Open Government Canada's CKAN catalogue;
- stream/normalize identification, financials, programs, qualified/non-qualified donees, foundations, Schedule 8 DQ and web-address resources;
- preserve original source columns under a stable BN-based envelope;
- search/fetch charities and foundations;
- inspect published Schedule 8 DQ fields without inventing a legal interpretation;
- transparently match foundation filing/history evidence to potential registered-charity recipients;
- model the `$135B × 8.5% × 5%` and `87,000 + 20%` scenarios;
- estimate nonprofit/foundation/government administrative capacity recovered.

### Authenticated workflow runtime

When `ENABLE_WORKFLOW_WRITES=1` and readiness passes, the MCP app also supports:

- OIDC/JWT authentication;
- organization-scoped RBAC using the production role model;
- PostgreSQL persistence and idempotent state events;
- AES-256-GCM encryption of private organization workflow profiles;
- HMAC-chained/tamper-evident application audit records;
- recipient claim verification and reusable recipient profiles;
- budget-constrained allocation plans, including plans drafted from T3010 matches;
- analyst/approver separation of duties;
- separate proportional diligence for non-qualified donees;
- compliance decisions and current recipient-status records;
- one-time browser offer links so recipients do **not** need ChatGPT to accept/decline;
- email/SMS webhook delivery adapters;
- external banking-verification references without storing bank account/card coordinates;
- payment intent creation, second-operator authorization and recording of an externally executed payment;
- T3010/T1441 reporting-record preparation and external filing-reference capture.

**The baseline app still cannot initiate a bank transfer and does not submit CRA returns.**

## Grant lifecycle

```text
draft -> proposed -> approved -> offered -> accepted
      -> payment_authorized -> paid -> reported
```

`declined` and `cancelled` are terminal exception states.

The operational sequence is:

```text
foundation analyst drafts/proposes
        ↓
separate foundation approver
        ↓
recipient offer + explicit consent
        ↓
compliance approval + fresh eligible status
        ↓
external banking verification
        ↓
payment operator creates intent
        ↓
different payment operator authorizes
        ↓
funds move OUTSIDE this app
        ↓
external payment reference recorded
        ↓
reporting record + external CRA filing reference
```

For a non-qualified donee, separately approved diligence is required before the grant plan can be approved.

## Recipient acceptance without ChatGPT

Offer dispatch creates a random 256-bit bearer token, stores only its SHA-256 hash, and sends a single-use browser URL. The browser endpoint expires the token, uses no-referrer/no-store/CSP response controls, records accept/decline and versioned consent, never asks for banking information, and cannot authorize or execute payment.

This allows a recipient organization to receive a matched offer without searching/applying for it first.

## Payment boundary

`PAYMENT_PROVIDER` remains limited to `disabled` or `manual`. The `manual` adapter means **external execution required**. It cannot move money. The clearing house records only an external banking-verification status/reference and an external payment reference after the operator confirms payment occurred elsewhere.

Bank account/card coordinates are deliberately outside the application schema.

## CRA status boundary

The public status-evidence tool can look for current published revocation evidence, but absence from the revocations page is **not** treated as proof of registration or eligibility.

A compliance reviewer must record an operational status decision (`eligible`, `ineligible`, `unknown`, or `needs_review`) for the specific grant. `eligible` must be fresh within `CRA_STATUS_MAX_AGE_HOURS` before payment authorization.

## Quick start — public/read-only

```bash
npm install
npm test
npm run readiness
npm run ingest:t3010 -- --year 2024
npm start
```

MCP endpoint: `http://localhost:3000/mcp`.

## Quick start — workflow development

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_core.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_workflow_runtime.sql
ENABLE_WORKFLOW_WRITES=1 npm start
```

Production workflow deployments must pass `NODE_ENV=production npm run readiness`.

## Roles

```text
system_admin
foundation_analyst
foundation_approver
compliance_reviewer
recipient_admin
payment_operator
auditor
```

Authorization uses both role **and organization scope**. Organization scope can come from trusted OIDC BN claims or verified database memberships. Approving a recipient claim creates the recipient membership in the database.

## MCP workflow tools

Authenticated workflow deployments add tools for organization/claim management, allocation plans, NQD diligence, compliance/status verification, offer dispatch and consent, external banking verification, payment intent/authorization, external-payment recording, reporting, and audit access.

There is intentionally **no `execute_payment`/bank-transfer tool** in the baseline MCP surface.

## ChatGPT app/plugin integration

Deploy the service to a remotely reachable HTTPS origin and connect `/mcp` through ChatGPT's current custom-app/plugin flow. Workflow-enabled deployments publish OAuth protected-resource metadata at `/.well-known/oauth-protected-resource`.

The repository implements the MCP app/backend; Plugin Directory packaging/distribution remains a separate ChatGPT publishing step.

## Production controls

See [docs/PRODUCTION_REQUIREMENTS.md](docs/PRODUCTION_REQUIREMENTS.md), [docs/WORKFLOW_RUNTIME.md](docs/WORKFLOW_RUNTIME.md), [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/T3010.md](docs/T3010.md), and [PRIVACY.md](PRIVACY.md).

## Sources

- CRA T3010 / List of charities: Open Government Canada
- Default 2024 dataset id: `80c00cdb-1358-415c-bb8b-0de7f12675b8`
- Open Government Canada CKAN API: `https://open.canada.ca/data/api/3/action`
