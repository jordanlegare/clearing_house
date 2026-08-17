# Architecture

## Data plane

`open.canada.ca CKAN package_show` → resource discovery → streaming CSV parser → normalized JSONL → in-memory T3010 repository.

The importer preserves every source column under `fields` and adds only a small canonical envelope (`bn`, `name`, resource kind, row number, source resource id/url). This avoids silently dropping CRA fields and makes schema changes diagnosable.

The default source set is:

- Identification
- General information
- Financial data
- Charitable programs
- Qualified donees
- Non-qualified donees
- Private/Public Foundations (Schedule 1)
- Disbursement Quota (Schedule 8)
- Charity Contact Web Addresses

Directors/officers are intentionally excluded from the default ingestion because they are unnecessary for this use case.

## Matching plane

The matching engine is deliberately transparent in both directions:

- foundations can rank recipient candidates from filing text, program descriptions, historical donees and explicit constraints; and
- recipients can rank foundations from recipient-approved profile/request facts and the same filing-derived foundation evidence.

Each result carries matched evidence terms, source vintage, and the canonical support signal when its component financial lines are published. That signal is a screening proxy—the maximum of qualified-donee gifts, non-qualified-donee grants and charitable-program expenditures—not a grant budget. The matcher does **not** produce an opaque social-impact score.

## Recipient application plane

Authenticated recipient administrators maintain a versioned funding profile and reusable requests. `src/applications/package.mjs` produces deterministic foundation-specific packages containing recipient facts, request facts, foundation evidence, shared terms, provenance, readiness findings and an external-filing boundary. A SHA-256 hash binds the complete package.

Application state is persisted separately from foundation-side grants:

```text
draft -> ready -> submitted -> awarded | declined | withdrawn
```

Readiness requires a complete current package and exact recipient confirmation. Submission requires recipient-provided evidence from an external foundation channel. Recording `awarded` never materializes a `grants` row; foundation approval, compliance and payment remain separate workflows.

Registered charities enter through T3010-backed organization claims. Non-qualified/non-lucrative ventures can create a pending organization claim without a BN, but system-admin verification is required before recipient-admin access is granted.

## ChatGPT plane

The server exposes Streamable HTTP MCP at `/mcp`. Read tools cover search/fetch, T3010 filing retrieval, planning DQ calculations, national scenarios, bidirectional matching, and organization-scoped application history. Authenticated write tools manage recipient-approved profiles, requests and application evidence in addition to the foundation-side grant workflow. `sync_t3010` is a local-write/open-network action and requires an exact confirmation string.

There is no payment rail, foundation-portal credential store, autonomous external application submission, or autonomous grant award action.
