# Recipient Funding Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let verified charities and non-qualified/non-lucrative ventures use ChatGPT to reuse organizational evidence, discover foundation fits, prepare grounded grant-application packages, and record external filing outcomes.

**Architecture:** Add a pure application-package domain module and reverse matcher, then persist recipient profiles, funding requests, immutable application snapshots, and lifecycle events in PostgreSQL. Expose the workflow through organization-scoped MCP tools while keeping external filing, current eligibility verification, and foundation decisions outside the application.

**Tech Stack:** Node.js 22+ ES modules, PostgreSQL 16, `pg`, Zod 3, MCP SDK 1.26, Node test runner, Docker Compose, GitHub Actions.

## Global Constraints

- CRA T3010 and historical donee evidence are screening evidence, not current eligibility or a grant budget.
- No tool may claim an external filing occurred without a recorded external reference and timestamp.
- A non-qualified venture claim remains pending until an administrator verifies it.
- Recipient workspace reads and writes require organization-scoped recipient-admin access, except system-admin access.
- All money is positive, finite, safe, and cent-exact.
- Application packages are deterministic and hash-bound; changed facts require a new draft.
- Application outcome recording never creates a foundation-side `grants` row.
- External and recipient text is untrusted data and cannot affect authorization.

---

## File map

- Create `src/applications/package.mjs`: normalization, readiness, canonical snapshot, hashing, and lifecycle transitions.
- Modify `src/t3010/repository.mjs`: transparent recipient-to-foundation matching.
- Create `db/migrations/015_recipient_funding_workspace.sql`: profile, request, application, and event persistence.
- Create `src/workflow/recipient_funding_workspace.mjs`: organization-scoped persistence/service functions.
- Create `src/mcp/application_tools.mjs`: recipient workspace MCP registry.
- Modify `src/mcp/workflow_tools.mjs`: venture claim tool and application-tool registration.
- Modify `src/db/workflow_repository.mjs`: atomic venture organization/claim creation.
- Modify `src/security/rbac.mjs`: explicit recipient funding permissions.
- Modify `src/db/schema_readiness.mjs`: require the new tables.
- Create `test/application_package.test.mjs`: pure package and lifecycle coverage.
- Modify `test/importer.test.mjs`: reverse matcher coverage using the existing T3010 fixture.
- Create `test/application_tools.test.mjs`: MCP registry and RBAC surface coverage.
- Create `scripts/recipient-funding-workspace-db-smoke.mjs`: PostgreSQL end-to-end smoke.
- Modify `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/ARCHITECTURE.md`, and `docs/PRODUCTION_REQUIREMENTS.md`: validation and operator documentation.

### Task 1: Deterministic application package domain

**Files:**
- Create: `src/applications/package.mjs`
- Create: `test/application_package.test.mjs`

**Interfaces:**
- Produces `moneyToCents(value, fieldName) -> number`.
- Produces `buildApplicationPackage({ recipientOrganization, profile, fundingRequest, foundation, matchedTerms }) -> { packageSnapshot, readiness, packageHash }`.
- Produces `transitionApplication(application, nextStatus, input) -> application`.

- [ ] **Step 1: Write failing domain tests**

Cover a complete package, missing required facts, order-stable hashing, cent rejection, stale hash rejection, and legal transitions:

```js
const built = buildApplicationPackage({
  recipientOrganization: { id: 'recipient-1', legalName: 'Community Kitchen', organizationType: 'registered_charity' },
  profile: { version: 2, mission: 'Improve food security', activities: ['Community meals'], populations: ['low-income households'], geography: ['Toronto'], outcomes: [{ name: 'Meals served', target: 12000 }], evidence: [{ label: '2025 annual report', url: 'https://example.ca/report' }] },
  fundingRequest: { id: 'request-1', version: 1, title: 'Refrigerated truck', purpose: 'Purchase a refrigerated delivery truck', amountCad: 85000, objectives: ['Recover more surplus food'], activities: ['Purchase and deploy truck'], outcomes: [{ name: 'Food recovered kg', target: 200000 }], budget: [{ label: 'Truck', amountCad: 85000 }], evidence: [{ label: 'Dealer quote', reference: 'quote-2026-08' }] },
  foundation: { bn: '123456789RR0001', name: 'Example Foundation', sourceYear: 2024, programDescriptions: ['food security equipment and transportation'] },
  matchedTerms: ['food', 'security', 'transportation']
});
assert.equal(built.readiness.ready, true);
assert.match(built.packageHash, /^[a-f0-9]{64}$/);
assert.throws(() => moneyToCents(10.001, 'amountCad'), /fractions of a cent/);
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test test/application_package.test.mjs`

Expected: failure because `src/applications/package.mjs` does not exist.

- [ ] **Step 3: Implement canonical package construction**

Implement bounded string/array normalization, cent-exact budget reconciliation, explicit readiness findings, a canonical JSON serializer with sorted object keys, and SHA-256 hashing. Required readiness codes are:

```js
export const READINESS_CODES = Object.freeze([
  'profile.mission_missing',
  'profile.activities_missing',
  'profile.populations_missing',
  'profile.geography_missing',
  'profile.outcomes_missing',
  'profile.evidence_missing',
  'request.objectives_missing',
  'request.activities_missing',
  'request.outcomes_missing',
  'request.budget_missing',
  'request.evidence_missing',
  'request.budget_total_mismatch',
  'foundation.evidence_missing',
  'foundation.match_terms_missing'
]);
```

The package snapshot must contain `schemaVersion: 1`, `recipient`, `profile`, `request`, `foundation`, `fit`, `sources`, and `filingBoundary: 'external_foundation_channel_required'`.

- [ ] **Step 4: Implement lifecycle validation**

Allow only:

```js
draft -> ready
draft -> withdrawn
ready -> submitted
ready -> withdrawn
submitted -> awarded
submitted -> declined
submitted -> withdrawn
```

`ready` requires no readiness findings, an exact current `packageHash`, and `confirmation === 'MARK APPLICATION READY'`. `submitted` requires `submissionChannel`, `externalSubmissionReference`, and an ISO timestamp. Outcome states require a non-empty rationale and decision timestamp.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/application_package.test.mjs`

Commit:

```bash
git add src/applications/package.mjs test/application_package.test.mjs
git commit -m "Add deterministic grant application packages"
```

### Task 2: Transparent recipient-to-foundation matching

**Files:**
- Modify: `src/t3010/repository.mjs`
- Modify: `test/importer.test.mjs`

**Interfaces:**
- Consumes the repository's existing `tokens`, `recordText`, `foundationProfile`, and foundation source maps.
- Produces `T3010Repository.matchRecipientFoundations({ profileText, requestText, province, limit, minimumSupportSignalCad })`.

- [ ] **Step 1: Add a failing fixture test**

Use the existing importer fixture and assert that matching a food-transport request returns a foundation with shared evidence terms, source year, and warnings:

```js
const match = repository.matchRecipientFoundations({
  profileText: 'Food security and community meals in Ontario',
  requestText: 'Refrigerated truck for food rescue transportation',
  province: 'ON',
  limit: 10
});
assert.ok(match.matches.length >= 1);
assert.ok(match.matches[0].matchedTerms.length >= 1);
assert.equal(match.screeningOnly, true);
assert.match(match.warnings.join(' '), /current guidelines/i);
```

- [ ] **Step 2: Run the importer test and confirm RED**

Run: `node --test test/importer.test.mjs`

Expected: `repository.matchRecipientFoundations is not a function`.

- [ ] **Step 3: Implement the reverse matcher**

Tokenize only the supplied profile/request text, score overlap against foundation name, program descriptions, Schedule 1 fields, and historical qualified-donee text, and return:

```js
{
  queryTerms,
  screeningOnly: true,
  warnings: [
    'Historical support evidence is not a current grant budget.',
    'Verify current guidelines, recipient eligibility, geography, deadlines, application channel, agreements and reporting requirements.'
  ],
  matches: [{ bn, name, province, sourceYear, designation, supportSignalCad, score, matchedTerms, rationale, evidence }]
}
```

Apply `minimumSupportSignalCad` only when a canonical support signal exists; never interpret absence as zero capacity. Keep the result deterministic by sorting score descending and BN ascending.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test test/importer.test.mjs`

Commit:

```bash
git add src/t3010/repository.mjs test/importer.test.mjs
git commit -m "Add recipient-first foundation matching"
```

### Task 3: Persistent recipient workspace and venture claims

**Files:**
- Create: `db/migrations/015_recipient_funding_workspace.sql`
- Create: `src/workflow/recipient_funding_workspace.mjs`
- Modify: `src/db/workflow_repository.mjs`
- Modify: `src/security/rbac.mjs`
- Create: `scripts/recipient-funding-workspace-db-smoke.mjs`

**Interfaces:**
- Produces `WorkflowRepository.createVentureOrganizationClaim({ actor, legalName, organizationType, province, evidence, idempotencyKey })`.
- Produces `RecipientFundingWorkspace` methods `getProfile`, `upsertProfile`, `createRequest`, `updateRequest`, `listRequests`, `matchFoundations`, `prepareApplication`, `listApplications`, `getApplication`, `transitionApplication`.

- [ ] **Step 1: Write the database smoke before persistence code**

The smoke must bootstrap a system admin and recipient actor, create a pending venture claim twice with one idempotency key, verify it once, upsert a profile, create a request, prepare a draft, mark it ready, record external submission, record an awarded outcome, and assert:

```js
assert.equal(replayedClaim.id, firstClaim.id);
assert.equal(application.status, 'awarded');
assert.equal(application.externalSubmissionReference, 'foundation-portal-2026-001');
assert.equal(await count('grants'), 0);
assert.ok(await count("audit_log WHERE action LIKE 'grant_application.%'") >= 4);
```

- [ ] **Step 2: Add migration tables and constraints**

Create the four tables from the design with UUID primary keys, organization foreign keys, integer versions, bounded lifecycle checks, JSONB payloads, unique idempotency keys, and indexes by recipient/status/date. Add a partial unique index preventing more than one active `draft`/`ready` application for the same request and foundation BN.

- [ ] **Step 3: Add explicit permissions**

Add `MANAGE_RECIPIENT_FUNDING` and `SUBMIT_RECIPIENT_APPLICATION` to `PERMISSIONS`; grant both to system administrators and recipient administrators only. Reuse `READ_PRIVATE_ORG` for scoped reads.

- [ ] **Step 4: Implement atomic venture claim creation**

Within one transaction, reuse an existing claim by idempotency key, reject replayed keys with different legal name/type/province, create an organization without a BN, create a pending `recipient_admin` claim, and append `recipient_claim.create_venture` to the audit chain.

- [ ] **Step 5: Implement workspace persistence and service rules**

Keep SQL in `recipient_funding_workspace.mjs` behind a `RecipientFundingWorkspace` constructed with `{ repository, t3010Repository }`. Every entry point must call `requireOrgPermission`; every mutation uses `withTransaction`, an idempotency key, and the repository audit hook exposed as `appendAudit`.

Persist a frozen package snapshot and package hash at preparation time. On transition, lock the application row, call the pure `transitionApplication`, reject a stale hash, insert one application event, update the row, and append audit.

- [ ] **Step 6: Run migration and smoke against PostgreSQL**

Run:

```bash
for migration in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"; done
node scripts/recipient-funding-workspace-db-smoke.mjs
```

Expected: the smoke prints a JSON summary with `status: "awarded"` and exits zero.

- [ ] **Step 7: Commit persistence slice**

```bash
git add db/migrations/015_recipient_funding_workspace.sql src/workflow/recipient_funding_workspace.mjs src/db/workflow_repository.mjs src/security/rbac.mjs scripts/recipient-funding-workspace-db-smoke.mjs
git commit -m "Add recipient funding workspace persistence"
```

### Task 4: ChatGPT MCP application tools

**Files:**
- Create: `src/mcp/application_tools.mjs`
- Modify: `src/mcp/workflow_tools.mjs`
- Modify: `src/workflow/workflow_service.mjs`
- Create: `test/application_tools.test.mjs`
- Modify: `test/workflow_tools.test.mjs`

**Interfaces:**
- Consumes `RecipientFundingWorkspace` and `WorkflowRepository.createVentureOrganizationClaim`.
- Produces `registerApplicationTools(server, { workspace, actor })` and the exact thirteen tools in the design.

- [ ] **Step 1: Write failing registry tests**

Use a fake server that records tool names and schemas. Assert all tools are registered, public profile/request text is bounded, all mutation inputs have `idempotencyKey`, readiness takes `packageHash` and exact confirmation, and outcome is limited to `awarded|declined|withdrawn`.

- [ ] **Step 2: Run the tool tests and confirm RED**

Run: `node --test test/application_tools.test.mjs test/workflow_tools.test.mjs`

Expected: missing application-tool module and missing registry names.

- [ ] **Step 3: Wire the workspace into the workflow service**

Construct `this.recipientFunding = new RecipientFundingWorkspace({ repository, t3010Repository })` in `WorkflowService`. Add `claimNonprofitVenture(actor, args)` delegating to the repository after validating `organizationType` as `non_qualified_donee|other`.

- [ ] **Step 4: Register venture and application tools**

Use read-only annotations for gets/lists/matches, non-destructive write annotations for profile/request/draft preparation, and consequential annotations for readiness, submission, and outcome transitions. Descriptions must state that matching is screening only and filing remains external.

Use these exact transition messages:

```js
'Marked the unchanged application package ready for recipient-controlled filing. Nothing was submitted.'
'Recorded recipient-provided evidence of an external foundation submission. This does not prove receipt or acceptance.'
'Recorded the recipient-reported application outcome. No grant-award workflow record was created.'
```

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/application_package.test.mjs test/application_tools.test.mjs test/workflow_tools.test.mjs`

Commit:

```bash
git add src/mcp/application_tools.mjs src/mcp/workflow_tools.mjs src/workflow/workflow_service.mjs test/application_tools.test.mjs test/workflow_tools.test.mjs
git commit -m "Expose recipient applications to ChatGPT"
```

### Task 5: Required validation and documentation

**Files:**
- Modify: `src/db/schema_readiness.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PRODUCTION_REQUIREMENTS.md`
- Modify: `test/production_requirements.test.mjs`

**Interfaces:**
- Makes `recipient_funding_profiles`, `recipient_funding_requests`, `grant_applications`, and `grant_application_events` required schema tables.
- Adds `test:recipient-funding-db` and includes every new module/script in `npm run check`.

- [ ] **Step 1: Add failing production requirement assertions**

Assert that recipient admins have both funding permissions, foundation analysts do not, schema readiness names all four tables, and the README describes both foundation-first and recipient-first paths.

- [ ] **Step 2: Run the requirement test and confirm RED**

Run: `node --test test/production_requirements.test.mjs`

- [ ] **Step 3: Extend required validation**

Add syntax checks for the domain, workspace, MCP tool, and DB smoke files. Add:

```json
"test:recipient-funding-db": "node scripts/recipient-funding-workspace-db-smoke.mjs"
```

Run it in CI after migrations with the existing `db-env` mapping.

- [ ] **Step 4: Document the dual workflow**

Add a README capability section showing:

```text
recipient profile + project
  -> transparent foundation screening
  -> grounded application package + missing-fact checklist
  -> recipient readiness confirmation
  -> external filing
  -> submission evidence + outcome history
```

Document venture verification, MCP tools, configuration impact (none beyond authenticated workflow prerequisites), the external filing boundary, immutable package hashes, and the support-signal caveat. Update the migration range to `015`.

- [ ] **Step 5: Run focused validation and commit**

Run:

```bash
node --test test/production_requirements.test.mjs
npm run check
```

Commit:

```bash
git add src/db/schema_readiness.mjs package.json .github/workflows/ci.yml README.md docs/ARCHITECTURE.md docs/PRODUCTION_REQUIREMENTS.md test/production_requirements.test.mjs
git commit -m "Document and gate recipient application workflow"
```

### Task 6: Full verification and GitHub handoff

**Files:**
- Modify only files required by failures found during verification.

**Interfaces:**
- Produces one verified branch and draft pull request against `main`.

- [ ] **Step 1: Run clean-tree syntax and unit verification**

Run:

```bash
npm install
npm run check
npm test
npm run readiness
git diff --check main...HEAD
```

- [ ] **Step 2: Run PostgreSQL and container verification**

Run the migration loop, `npm run schema:check`, `npm run test:db`, `npm run test:recipient-funding-db`, existing specialized DB smokes, `docker compose config`, and `docker build -t clearing-house-recipient-workspace .`.

- [ ] **Step 3: Review security and product boundaries**

Confirm no tool can grant its own venture claim, no recipient can access another organization, no application transition bypasses hash/readiness checks, no raw credentials/banking fields were added, no award creates a grant row, and all external-filing copy remains evidentiary.

- [ ] **Step 4: Commit any verification fixes**

Use a focused message that names the failure fixed; do not combine unrelated changes.

- [ ] **Step 5: Publish a draft pull request**

Push `agent/recipient-funding-workspace` and create a draft PR titled `Add recipient-first grant application workspace`. Include the design/plan links, behavior summary, test evidence, external filing boundary, and any environment-only verification limits.
