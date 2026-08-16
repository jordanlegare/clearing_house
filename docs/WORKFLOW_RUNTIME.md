# Workflow runtime

The production workflow layer sits on top of the public T3010 discovery engine and the production requirements established in `db/migrations/001_core.sql`.

## Storage

`db/migrations/002_workflow_runtime.sql` adds allocation plans, non-qualified-donee diligence, one-time offer tokens, payment-intent creator separation, and browser-consent metadata.

Private organization workflow data is AES-256-GCM encrypted by the application before it enters PostgreSQL. The runtime stores contact data and external banking-verification references; it deliberately does not store bank account or card coordinates.

## Identity and RBAC

Remote workflow MCP connections authenticate with OIDC/JWT. Authorization combines the role model in `src/security/rbac.mjs` with organization scope from either trusted token BN claims or verified database memberships.

Approved recipient claims create a `recipient_admin` membership, so a charity can begin with a claim request and subsequently maintain one reusable profile.

## Allocation and compliance

Foundation analysts can create or match a budget-constrained plan, then propose it. Foundation approvers are separately permissioned, and proposer/approver separation is enforced by the grant lifecycle.

Non-qualified-donee grants require documented proportional diligence and a separate compliance-reviewer approval before the plan can be approved.

A payment cannot be authorized until the grant also has explicit recipient acceptance, external banking verification, a current operational recipient-status record marked `eligible`, and grant compliance approval.

The public CRA revocations check is evidence only. It can block dispatch when revocation evidence is found, but absence from that page is never treated as an `eligible` status decision.

## Recipient acceptance without ChatGPT

Dispatch creates a random 256-bit offer token, persists only its SHA-256 hash, and sends a single-use browser link. The browser endpoint uses no-referrer/no-store/CSP headers and records accept/decline only. It cannot collect banking information or authorize payment.

## Payment boundary

The baseline payment providers remain `disabled` or `manual`. A payment operator can create an intent; a different payment operator must authorize it. The resulting state requires external execution. `record_external_payment` only records a payment reference after funds moved outside this application.

There is no bank-transfer execution tool in the baseline MCP surface.

## Reporting

Paid grants can generate a reporting record. Non-qualified-donee reporting classification aggregates grants to the same recipient for the fiscal period before determining the T1441 route. A compliance reviewer records an external filing reference before the grant can move to `reported`.

The runtime does not submit CRA returns directly.
