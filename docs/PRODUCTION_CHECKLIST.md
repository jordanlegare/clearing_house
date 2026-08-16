# Production activation checklist

## Before participant data
- Deploy behind HTTPS.
- Configure production OIDC issuer/client/audience discovery and JWKS validation.
- Configure 32+ character encryption and audit-HMAC secrets from a secret manager.
- Apply all PostgreSQL migrations and test backup/restore.
- Publish operator privacy, retention, breach-response and subprocessors information.

## Before real offers
- Ingest the current T3010 dataset.
- Establish recipient-claim verification procedures.
- Configure and test the notification provider.
- Verify one-time offer links from outside the deployment network before enabling browser acceptance.
- Establish analyst/approver and diligence reviewer separation of duties.

## Before payment authorization
- Integrate external banking verification; store only provider status/reference in this app.
- Establish payment-operator creator/authorizer separation.
- Define the authoritative process for recording `eligible` recipient status.
- Set `CRA_STATUS_MAX_AGE_HOURS` to the operational release window.

## Before recording payments
- Use an external banking/payment process with its own authentication and reconciliation.
- Record a stable external payment reference in the clearing house.
- Keep bank account/card coordinates outside this application.

## Before CRA filing
- Validate T3010/T1441 mappings against the filing package in force.
- Retain diligence, status, approvals, consent, payment reference and reporting workpapers.
- Use the CRA-authorized filing channel; the app does not claim a direct CRA filing API.
