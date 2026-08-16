# Threat Model

## Assets

- Foundation allocation/approval authority
- Recipient identity and contact data
- Grant terms, decisions and payment references
- T3010-derived public records and normalized indexes
- Authentication tokens/refresh tokens
- Audit-log integrity

## Trust boundaries

1. ChatGPT/MCP client -> Clearing House MCP endpoint
2. Public Open Government data -> ingestion pipeline
3. Auth provider -> application identity
4. Clearing House -> notification provider
5. Clearing House -> external/manual payment process
6. Operator/admin -> production database and audit system

## Priority threats and controls

### Prompt injection / untrusted public text
Threat: a T3010 description or recipient-supplied profile contains instructions designed to cause a tool action.

Controls: retrieved text never changes authorization; write actions require server-side RBAC, state-machine validation and explicit human confirmation. Matching text is treated as data only.

### Unauthorized grant approval
Threat: analyst, recipient or compromised account approves foundation spending.

Controls: OIDC identity, organization-scoped RBAC, separation of duties, approval audit event, optional step-up authentication for payment authorization.

### Duplicate/replayed writes
Threat: retries create duplicate offers, notifications or payment records.

Controls: idempotency keys with unique database constraints and append-only grant events.

### Stale or incorrect CRA status
Threat: historical filing data is mistaken for current eligibility.

Controls: release-time status check with evidence timestamp and expiry; stale/unknown status blocks payment authorization.

### Recipient impersonation
Threat: attacker claims a charity/nonprofit profile and accepts an award.

Controls: claim-verification workflow, organization/domain evidence, recipient-scoped role and auditable consent.

### Payment fraud
Threat: bank details are changed or model output initiates money movement.

Controls: no automated payment provider in baseline; manual external execution; future payment rail requires dual authorization, payee-change controls and reconciliation.

### Sensitive data exposure
Threat: private contacts or banking references appear in public MCP search results.

Controls: separate public/private data models, field-level serialization rules, access logs, data minimization and encryption.

### Audit tampering
Threat: actor alters history after an improper decision/payment.

Controls: append-only table, chained digest/HMAC fields, restricted audit key, immutable/remote log export in production.
