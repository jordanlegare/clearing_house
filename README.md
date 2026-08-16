# Canadian Philanthropy Clearing House

A **ChatGPT-compatible MCP plugin/app** for turning Canadian foundation disbursement capacity into discoverable, auditable matches with registered charities—without making frontline organizations repeatedly search and apply for the same capital.

The project ingests public **CRA T3010 List of charities** data from Open Government Canada and exposes it to ChatGPT through a Streamable HTTP MCP server.

## What works now

- Discover the CRA T3010 CSV resources from Open Government Canada's public CKAN catalogue.
- Stream and normalize Identification, financials, programs, qualified/non-qualified donees, foundations, **Schedule 8 DQ**, and web-address data.
- Preserve all source columns while adding a stable BN-based envelope.
- Search Canadian registered charities and foundations.
- Fetch a filing-derived charity/foundation profile by stable id.
- Return a foundation's published Schedule 8 DQ fields without pretending to make a legal determination.
- Match foundation filing/history evidence to charities with transparent matched terms.
- Model the `$135B × 8.5% return × 5% DQ` scenario and the `87,000 + 20%` recipient-universe scenario.
- Estimate administrative hours recovered across nonprofits, foundations and government.
- Expose all of the above through ChatGPT-compatible MCP tools at `/mcp`.

**No payment rail exists. No tool awards or transfers money.**

## Current ChatGPT integration

OpenAI's current app/plugin path is MCP-based. Run this service on a remote HTTPS host, then configure the `/mcp` endpoint as a custom app/plugin in ChatGPT developer mode. The server also provides conventional `search` and `fetch` tools for read/fetch use cases.

## Quick start

```bash
npm install
npm test
npm run ingest:t3010 -- --year 2024
npm start
```

Then verify:

```bash
curl http://localhost:3000/healthz
```

MCP endpoint:

```text
http://localhost:3000/mcp
```

ChatGPT itself requires a remotely reachable endpoint (or an approved secure tunnel), not a bare localhost endpoint.

## Fast T3010 smoke ingest

```bash
npm run ingest:t3010 -- --year 2024 \
  --resources identification,foundations,disbursement_quota \
  --max-rows 100 --output .tmp/t3010-smoke
```

A full default ingest streams nine public resources and writes normalized JSONL under `data/t3010/2024/`. Data files are ignored by git; the application should ingest them into persistent deployment storage rather than vendoring CRA data into the source repository.

## MCP tools

| Tool | Purpose |
|---|---|
| `dataset_status` | Show loaded CRA T3010 dataset/version/counts |
| `search` | Conventional cross-entity search returning stable fetch ids |
| `fetch` | Fetch a charity/foundation profile by id |
| `search_charities` | Mission/geography search across T3010 charities |
| `search_foundations` | Foundation search with filing/history evidence |
| `get_foundation_dq_record` | Return published Schedule 8 DQ fields |
| `match_foundation_recipients` | Transparent foundation→charity matching |
| `calculate_foundation_dq` | Planning-level DQ scenario calculation |
| `model_foundation_capital` | Multi-year return/disbursement model |
| `national_allocation_scenario` | `$135B / 8.5% / 5% / 104,400` scenario engine |
| `estimate_admin_capacity_saved` | Nonprofit/foundation/government time-savings model |
| `sync_t3010` | Optional, explicitly confirmed Open Canada→local data synchronization (`ENABLE_T3010_SYNC=1`) |
| `open_canada_catalogue` | Source metadata/status |

## Safety and compliance boundaries

- T3010 data is public/self-reported filing data; it is not a live legal-status guarantee.
- Matching is discovery, not an award, CRA approval, or impact determination.
- DQ calculations are planning scenarios unless statutory inputs/rules are independently verified.
- The default importer excludes directors/officers.
- Public deployments are read-only by default. `sync_t3010` is exposed only with `ENABLE_T3010_SYNC=1` and then requires an exact confirmation string before writing local data.
- No banking credentials, payment execution, tax receipting, SMS, or grant acceptance is implemented.

## Sources

- CRA T3010 / List of charities: Open Government Canada
- Default 2024 dataset id: `80c00cdb-1358-415c-bb8b-0de7f12675b8`
- Open Government Canada CKAN API: `https://open.canada.ca/data/api/3/action`

See [docs/T3010.md](docs/T3010.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), and [PRIVACY.md](PRIVACY.md).
