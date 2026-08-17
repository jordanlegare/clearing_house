# Production Requirements

Status: **normative requirements for the next production tranche**. The public T3010 discovery layer may run without workflow writes. Grant workflow writes must remain disabled until all P0 controls below are satisfied.

## 1. Product objective

The Clearing House should reduce the administrative cost of matching Canadian foundations to charities and other grant recipients while preserving four boundaries:

1. Foundation trustees/authorized staff make grant decisions; the model does not exercise fiduciary authority.
2. Recipient organizations explicitly accept restricted or unrestricted grant terms before a payment can be authorized.
3. Public CRA/T3010 data is evidence, not a live legal-status certificate.
4. No model/tool invocation directly moves money. A separately authorized payment operator records an external payment rail or a future bank/payment adapter after human authorization.

## 2. P0 launch requirements

### Identity and authorization

- Production workflow writes require OAuth/OIDC-backed identity.
- ChatGPT app authentication must be configured through the current app/MCP connection flow.
- For OIDC, the provider should advertise and issue refresh/offline access so ChatGPT can maintain authorized connectivity.
- Every write event has an authenticated actor, organization membership, role and request/idempotency identifier.
- RBAC must separate at least: foundation analyst, foundation approver, compliance reviewer, recipient administrator, payment operator, auditor and system administrator.
- Separation of duties is mandatory by default: the person proposing a grant cannot approve the same grant.

### Data and persistence

- PostgreSQL (or a persistence layer offering equivalent transactional guarantees) is required before workflow writes are enabled.
- Grant state transitions, recipient consents, status checks, payment records and reporting records are durable.
- Write endpoints are idempotent. Replayed requests cannot duplicate grants, notifications or payment records.
- Audit records are append-only and tamper-evident; production deployments must protect audit keys separately from the application database.
- T3010 source rows remain versioned with dataset/resource identifiers and retrieval metadata.

### Recipient identity and status

- A recipient can claim an organization profile only after identity/domain/organizational verification appropriate to the risk.
- A grant cannot be accepted by a user outside the recipient organization.
- Before payment authorization, recipient eligibility/status must be re-verified from a current authoritative or explicitly approved source. The default maximum age is 24 hours and is configurable.
- A stale T3010 filing must never be represented as proof of current charitable registration.

### Grant workflow

Required state machine:

`draft -> proposed -> approved -> offered -> accepted -> payment_authorized -> paid -> reported`

Exceptional terminal states: `declined`, `cancelled`.

Controls:

- Positive amount, foundation, recipient and purpose are required before proposal.
- Approval requires foundation-approval authority and separation of duties.
- Offer occurs only after grant terms and recipient identity route are established.
- Acceptance requires explicit recipient consent and a versioned terms record.
- Payment authorization requires fresh recipient-status verification and compliance approval.
- Recording `paid` requires an external payment reference.
- Recording `reported` requires a reporting record.

### Recipient application workflow

- Registered charities require a verified T3010-backed organization claim before recipient funding data can be managed.
- A non-qualified/non-lucrative venture claim creates no access until a system administrator independently verifies authority.
- Recipient profiles, funding requests and applications are private organization-scoped data.
- Reverse foundation matching exposes its filing-derived evidence and never represents historical support as a current grant budget.
- Application packages are deterministic and bind the recipient profile version, request version, foundation BN/source vintage, amount, evidence and readiness findings with a SHA-256 hash.
- Missing facts produce readiness findings; neither ChatGPT nor the service fills them with invented content.
- Marking an application ready requires recipient-admin authority, a matching package hash, no unresolved readiness findings and exact confirmation.
- Recording submission requires a recipient-provided external channel, reference and timestamp. The application does not log in to or scrape foundation portals.
- Recording an awarded outcome does not create a `grants` row, approve payment or prove that funds moved.
- Changed source facts require a new application draft; stored application snapshots remain immutable.

### Compliance and CRA reporting

- The system must distinguish gifts/qualifying disbursements to qualified donees from grants to non-qualified donees.
- For non-qualified donees, reporting classification must aggregate grants by grantee across the fiscal period. Under current CRA guidance, totals above CAD 5,000 for a grantee require T1441 reporting; totals of CAD 5,000 or less follow the T3010 C16 aggregate route.
- Exact T3010/T1441 fields must be versioned to the current CRA filing package; do not encode prompt-only field mappings.
- DQ calculations are deterministic code and must preserve the distinction between planning scenarios and filed CRA Schedule 8 amounts.
- A compliance reviewer can block a grant independently of the matcher/model.

### Payment boundary

- Default provider is `disabled`.
- First production-capable provider is `manual`: the system can authorize and record a payment executed outside the Clearing House, but cannot initiate the bank transfer.
- Any future automated banking/payment provider requires a separate security review, least-privilege credentials, transaction limits, dual authorization, reconciliation, charge/return handling and incident procedures.

### Notification boundary

- Notification delivery uses an outbox with idempotency keys and retry state.
- Recipient contact details are private workflow data and must not be exposed through public search tools.
- SMS/voice/email providers are replaceable adapters. Console delivery is development-only.
- Messages must never state that funds were paid until the payment record is in `paid` state.

## 3. Privacy and security requirements

- Minimize personal information; public discovery should use public organization data rather than director/officer data unless a later feature has a documented need.
- Encrypt sensitive workflow data in transit and at rest; secrets belong in a managed secret store, not Git or environment files committed to the repository.
- Apply RBAC to private organization profiles and audit access to personal information.
- Maintain retention/deletion schedules by record class and legal/business requirement rather than retaining all operational data indefinitely.
- Maintain breach/incident response, key rotation, backup restore tests and dependency/security patching.
- Treat foundation descriptions, recipient profiles and external content as untrusted input for prompt-injection purposes. Tool authorization is determined by code/RBAC, never by text contained in retrieved records.

## 4. ChatGPT app/plugin requirements

- Remote HTTPS MCP endpoint for ChatGPT; local-only endpoints are insufficient except through an approved secure tunnel during development.
- Read tools remain broadly available; write/modify tools are exposed only after identity, RBAC and persistence are configured.
- Write tools use accurate MCP annotations so ChatGPT can surface confirmation appropriately.
- App privacy policy and operator contact information must be published before public distribution.
- The MCP app is the integration backend; Plugin Directory packaging/publication is a separate ChatGPT distribution step.
- Recipient application tools must describe matching as screening, readiness as non-submission, and external references as evidence rather than proof of receipt or acceptance.

## 5. Reliability requirements

Target initial SLOs (to be validated after load testing):

- Read/search API: 99.9% monthly availability.
- Grant workflow writes: 99.95% successful durable writes excluding rejected validation/auth requests.
- P95 public search latency: < 1.5 s on a warmed production index.
- Recovery point objective for workflow DB: <= 5 minutes.
- Recovery time objective: <= 60 minutes.
- No duplicate grant events or payment records under request retry/replay tests.

## 6. Data-quality requirements

- Preserve raw public source fields alongside normalized indexes.
- Record source dataset ID, resource ID, source URL, ETag/last-modified where available and ingestion timestamp.
- Schema drift should fail visibly: unknown fields are preserved; missing critical identifiers produce quarantine/error metrics rather than silent dropping.
- Match results expose reasons/evidence and never use a hidden single “worthiness” score as the sole allocation decision.
- Geography, organization size and historical funding may inform search/routing but require bias/fairness review before becoming automatic allocation constraints.

## 7. Operational readiness gates

A production deployment is **blocked** if any of these are true:

- HTTPS public base URL missing.
- Workflow writes enabled without persistent database.
- Workflow writes enabled without OIDC issuer/client configuration.
- Workflow writes enabled without encryption/audit keys.
- No tested backup/restore process for private workflow data.
- No current-recipient-status verification path.
- No privacy policy/operator contact.
- Payment adapter can initiate money movement without a separately authorized human-controlled rail.

## 8. Current authoritative references

- OpenAI: Apps SDK / MCP app guidance and Developer Mode documentation (current as of 2026-08-16).
- CRA: T3010 guide, annual DQ rules, T1441 and CG-032 guidance for grants to non-qualified donees.
- Canada privacy guidance: PIPEDA/private-sector privacy principles as applicable, plus provincial requirements where applicable to the operator/activity.

This document is an engineering/compliance requirements baseline, not legal advice. Production counsel/accounting review should sign off on the exact operational model and filing mappings before automated reporting is relied upon.
