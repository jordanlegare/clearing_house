# Recipient Funding Workspace Design

## Goal

Add a recipient-first grant-filing path to the existing foundation-first Clearing House. A verified representative of a registered charity or other non-qualified/non-lucrative venture should be able to maintain reusable organizational evidence, describe a funding request once, find plausible Canadian foundation matches through ChatGPT, prepare a foundation-specific application package, and record the result of an external filing.

The feature reduces repeated application work. It does not decide legal eligibility, guarantee a match, submit to a foundation portal, or imply that a foundation received or approved an application.

## Product boundaries

- CRA T3010 filings and historical qualified-donee evidence are screening evidence, not a current eligibility determination or a foundation grant budget.
- Current foundation guidelines, geography, recipient type, deadlines, application method, agreements, and reporting requirements remain explicit verification items.
- ChatGPT may help draft and organize content, but stored application packages are built deterministically from recipient-approved fields and source snapshots.
- A recipient administrator controls its organization profile, requests, application readiness, submission record, and outcomes.
- A non-qualified or other non-lucrative venture can request an organization claim without a registered-charity business number, but an administrator must verify the claim before access is granted.
- “Submitted” requires an external submission reference and timestamp. The Clearing House does not log in to or scrape foundation portals in this tranche.

## Chosen approach

Build a persistent recipient funding workspace alongside the existing grant-award workflow.

A public-only reverse matcher would not eliminate repetitive application data entry or preserve a reliable history. Direct portal automation would introduce unstable integrations and unsafe credential handling. The persistent workspace supplies the reusable middle layer while retaining a clean boundary around external filing.

## Data model

Migration `015_recipient_funding_workspace.sql` adds four organization-scoped resources:

1. `recipient_funding_profiles`: one versioned, mutable profile per recipient organization containing mission, activities, populations, geography, outcomes, governance, financial summary, and evidence references.
2. `recipient_funding_requests`: reusable project or operating requests with title, purpose, amount, dates, objectives, activities, outcomes, budget, geography, populations, and evidence references.
3. `grant_applications`: one foundation-targeted application record with lifecycle `draft -> ready -> submitted -> awarded|declined|withdrawn`. It retains the target foundation BN/name, deterministic package snapshot and hash, readiness findings, and external submission evidence.
4. `grant_application_events`: idempotent append-only lifecycle events used with the existing HMAC audit chain.

Profiles and requests store structured JSON fields behind bounded validators so later foundation-specific question sets can be added without a migration. Application snapshots are immutable after readiness; if recipient facts change, a new draft application is prepared.

## Recipient identity

The existing registered-charity claim remains unchanged. A new `claim_nonprofit_venture` operation creates or reuses an organization of type `non_qualified_donee` or `other` and creates a pending recipient-admin claim atomically. It requires a legal name, province, claimant evidence, and an idempotency key. It never grants access directly; the existing system-admin claim verification flow remains the gate.

## Matching and application package flow

1. A recipient administrator creates or updates its funding profile.
2. It creates a funding request with a positive cent-exact amount and structured objectives/evidence.
3. `match_recipient_foundations` derives search terms from the request and profile, searches foundation T3010/program/historical-gift evidence, and returns transparent matched terms, rationale, source vintage, and screening warnings. Optional province and minimum support-signal filters only narrow discovery.
4. The recipient chooses a foundation and asks ChatGPT to prepare an application.
5. The service fetches the current recipient profile, request, and foundation filing-derived profile, then builds a canonical package. The package includes organization facts, request facts, a foundation-fit section based only on shared evidence terms, source provenance, and a readiness checklist.
6. Missing mission, objectives, outcomes, budget, evidence, requested amount, or foundation evidence keeps the package in `draft` and exposes exact remediation items.
7. The recipient marks a complete, hash-matching draft `ready` with an exact confirmation string.
8. After filing through an external foundation channel, the recipient records the channel, external reference, and submitted time. Outcomes can later be recorded without creating a grant-award record automatically.

The application hash binds the recipient organization, profile version, request version, foundation BN/source vintage, requested amount, structured package, and readiness findings.

## MCP tools

Authenticated tools:

- `claim_nonprofit_venture`
- `get_recipient_funding_profile`
- `upsert_recipient_funding_profile`
- `create_recipient_funding_request`
- `update_recipient_funding_request`
- `list_recipient_funding_requests`
- `match_recipient_foundations`
- `prepare_grant_application`
- `list_grant_applications`
- `get_grant_application`
- `mark_grant_application_ready`
- `record_grant_application_submission`
- `record_grant_application_outcome`

Read tools are organization-scoped. Writes require recipient-admin membership for the recipient organization, use idempotency keys, and carry accurate MCP write/consequential annotations.

## Error handling and safety

- Reject invalid BNs, unknown foundation records, non-cent amounts, oversized fields, unknown lifecycle transitions, cross-organization access, stale package hashes, and idempotency-key reuse with different inputs.
- Return readiness findings rather than silently filling missing recipient facts.
- Escape or treat all external/free-text evidence as untrusted content; it never changes authorization or tool behavior.
- Keep external submission references as evidence only and never describe them as foundation acceptance.
- Do not create a `grants` row when an application is awarded; foundation-side onboarding and approval remain separate.

## Testing

- Unit tests cover reverse matching, deterministic package hashing, readiness findings, cent-exact amount validation, lifecycle transitions, stale-hash rejection, and tool registration.
- PostgreSQL smoke coverage applies the new migration and exercises venture claiming, profile/request persistence, application preparation, readiness, submission, and outcome recording with organization-scope and audit assertions.
- Existing unit, syntax, schema-readiness, database, Docker, public MCP, and authenticated fail-closed CI gates remain required.

## Documentation and operations

Update the README, architecture, production requirements, package scripts, schema readiness list, and CI database smoke step. The documentation must show both supported paths:

- foundation-first no-application offers; and
- recipient-first externally filed applications.

Neither path removes human fiduciary, legal, compliance, or external filing responsibility.
