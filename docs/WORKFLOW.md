# Authenticated Grant Workflow

This document describes the first production workflow exposed through the ChatGPT MCP app.

## Identity and authorization

When `ENABLE_WORKFLOW_WRITES=1`, `/mcp` is a protected resource. Requests must carry an OIDC/OAuth bearer token. The server validates the token using the issuer discovery document and JWKS, then resolves roles from PostgreSQL. Roles in token text or model output are never trusted for authorization.

ChatGPT deployments should configure an OAuth/OIDC provider that issues refresh tokens and advertises `offline_access` so authenticated connectivity can survive access-token expiry.

Roles are organization scoped. A `foundation_approver` membership at Foundation A grants no authority at Foundation B. `system_admin` is a separate global role and is bootstrapped by an operator using `npm run bootstrap:admin`.

## Organization onboarding

1. A user authenticates at least once.
2. A registered charity can call `claim_recipient_organization` using its BN.
3. A foundation can call `claim_foundation_organization` using its BN.
4. Claims are matched to the loaded CRA T3010 public profile and remain pending.
5. A global system administrator independently verifies authority and calls `verify_organization_claim`.
6. Recipient claims grant `recipient_admin`; foundation claims grant only `foundation_analyst`.
7. Higher-risk roles such as `foundation_approver`, `compliance_reviewer`, and `payment_operator` require the separate `grant_organization_role` admin action.

## Grant lifecycle

```text
draft -> proposed -> approved -> offered -> accepted
      -> payment_authorized -> paid -> reported
```

`declined` and `cancelled` are terminal exception states.

The proposer cannot approve the same grant when separation of duties is enabled. The recipient must accept the exact offered terms version. Payment authorization additionally requires a fresh authoritative CRA status observation and an approved compliance review.

## CRA status verification

Annual Open Government/T3010 data is useful for discovery and screening but is not accepted as release-time verification. `record_cra_status_verification` records a compliance user's current observation from CRA's List of Charities. Only an authoritative `registered` observation inside the configured freshness window can satisfy the payment gate. Suspended, revoked, and annulled observations are ineligible; penalized status requires review.

The reference app records the observation and audit evidence. It does not claim that an automated public CRA API exists where none is documented.

## Recipient notification

`offer_grant` can queue an SMS or voice notification. Notification destinations are AES-256-GCM encrypted before storage. A separate worker (`npm run dispatch:notifications`) claims outbox rows with `FOR UPDATE SKIP LOCKED`, decrypts the destination in memory, and sends through the configured provider.

The built-in production provider is Twilio (`NOTIFICATION_PROVIDER=twilio`). Notification sending is operationally separate from ChatGPT's grant-state mutation, so provider outages do not corrupt the grant state. Failed deliveries retry up to three worker attempts before being marked failed.

## Payments

The baseline app does not execute banking transactions. `authorize_manual_payment` creates a manual payment intent after all release gates pass. `record_manual_payment` records an external payment reference after a human-controlled banking/payment system executes the transfer.

This separation is deliberate: an LLM cannot unilaterally move foundation funds.

## Reporting

`prepare_reporting_record` builds a reviewable reporting package from grants paid during the supplied foundation fiscal period. For non-qualified donees, grants are aggregated by grantee before the current CRA $5,000 threshold is applied. If the aggregate exceeds $5,000, T1441 routing is flagged and each grant is reportable individually; lower aggregate grantees route through T3010 C16 aggregate reporting. Qualified-donee gifts remain outside T1441.

The output is a preparation artifact. It does not submit to CRA or claim that CRA accepted a return.

## Audit and idempotency

Every consequential database write has an idempotency key. Audit entries form an HMAC chain serialized with a PostgreSQL advisory transaction lock so concurrent writes cannot fork the chain. Notification destinations are never emitted back through MCP after storage.
