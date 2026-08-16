# Workflow runtime extensions

The production workflow layer is the authenticated PostgreSQL-backed runtime documented in `docs/WORKFLOW.md`. PR #3 has been reconciled onto that newer runtime rather than replacing it.

`db/migrations/003_runtime_extensions.sql` carries forward the non-overlapping schema from the earlier runtime branch: allocation-plan metadata, proportional non-qualified-donee diligence, one-time browser offer tokens, payment-intent creator separation, browser-consent metadata, and external banking-verification references.

The existing runtime remains authoritative for OIDC authentication, organization-scoped RBAC, idempotent grant transitions, encrypted notification destinations, current CRA status observations, manual/external payment recording, and T3010/T1441 reporting preparation.

## Intended extension boundaries

- **NQD diligence:** a non-qualified-donee grant can carry a proportional diligence assessment prepared by one actor and approved by a different compliance reviewer.
- **Browser recipient acceptance:** an offered grant can use an expiring 256-bit bearer token whose SHA-256 hash is stored server-side. Browser acceptance/decline records consent only; it cannot authorize payment or collect banking credentials.
- **Payment separation:** a payment operator creates an intent and a different payment operator authorizes it. Funds still move outside this application.
- **Banking verification:** only encrypted external verification references/status are retained; bank account/card coordinates remain out of scope.
- **CRA public evidence:** a revocations-page check can provide blocking evidence, but absence from that page is never proof of current registration or eligibility.

These extensions are additive to the workflow merged in PR #4 and must preserve its fail-closed release gates.
