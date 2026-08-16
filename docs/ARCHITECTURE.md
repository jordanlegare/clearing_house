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

The first matching engine is deliberately transparent. It uses normalized textual overlap from public T3010 program descriptions, foundation filing text, and historical qualified-donee rows, plus explicit user filters. Each result carries matched evidence terms. It does **not** produce an opaque social-impact score.

## ChatGPT plane

The server exposes Streamable HTTP MCP at `/mcp`. Read tools cover search/fetch, T3010 filing retrieval, planning DQ calculations, national scenarios, and recipient matching. `sync_t3010` is a local-write/open-network action and requires an exact confirmation string.

There is no payment rail and no autonomous grant award action.
