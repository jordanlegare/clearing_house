# Canadian Philanthropy Clearing House

A **ChatGPT plugin-compatible MCP app/backend** for turning Canadian foundation disbursement capacity into discoverable, auditable matches with registered charities—without making frontline organizations repeatedly search and apply for the same capital.

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
- Enforce a production requirements layer covering runtime readiness, RBAC, grant-state transitions, CRA reporting classification, safe notification/payment adapters and a PostgreSQL workflow schema.

**No payment rail executes money. No tool autonomously awards or transfers foundation funds.**

## ChatGPT Plugins / Apps compatibility

As of July 2026, OpenAI's Plugin Directory is the discovery/package layer. A plugin can include one or more apps, skills, and app templates; an **app** remains the integration that connects ChatGPT to external data and actions. This repository implements that underlying MCP app/backend.

To use it in ChatGPT:

1. deploy this service to a remotely reachable HTTPS host;
2. create a custom app in ChatGPT developer mode using the deployed `/mcp` endpoint and scan its tools;
3. configure OAuth/OIDC before exposing authenticated write actions;
4. test and publish the app for the intended workspace;
5. create/import/submit or otherwise make available the containing plugin when Plugin Directory distribution is desired.

A remote MCP app does not, by itself, create a Plugin Directory listing. The repository therefore does **not** invent an obsolete `ai-plugin.json` manifest or a proprietary plugin package format that OpenAI does not document for this flow.

## Quick start

```bash
npm install
npm test
npm run readiness
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

## Production readiness

Copy `.env.example`, then configure the deployment. Workflow writes are **disabled by default** and must remain disabled until the production gates are met.

```bash
cp .env.example .env
npm run readiness
```

The production baseline requires:

- HTTPS public endpoint
- PostgreSQL-compatible durable persistence
- OAuth/OIDC identity for workflow actors
- organization-scoped RBAC and separation of duties
- versioned recipient consent
- fresh recipient-status verification before payment authorization
- append-only/tamper-evident audit records
- idempotency for grant, notification and payment events
- operator privacy/security program
- safe notification provider configuration
- payment execution outside the baseline app (`disabled` or `manual` adapter only)

The deterministic grant lifecycle is:

```text
draft -> proposed -> approved -> offered -> accepted
      -> payment_authorized -> paid -> reported
```

`declined` and `cancelled` are terminal exception states.

See [docs/PRODUCTION_REQUIREMENTS.md](docs/PRODUCTION_REQUIREMENTS.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), and [docs/OPERATIONS.md](docs/OPERATIONS.md).

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

Write/modify grant tools are intentionally **not** exposed yet. The new workflow/RBAC/schema code establishes the requirements those tools must satisfy before they can be safely enabled.

## CRA reporting boundary

The compliance module distinguishes qualified donees from non-qualified donees. For non-qualified donees, it aggregates grants to the same grantee across the fiscal period before applying the current CRA reporting threshold. Exact T3010/T1441 field mappings must remain versioned to the filing package in force.

T3010 data remains public/self-reported filing data and is not treated as a live legal-status guarantee. A current status check is required before payment authorization in the workflow model.

## Safety and compliance boundaries

- Matching is discovery, not an award, CRA approval, or impact determination.
- DQ calculations are planning scenarios unless statutory inputs/rules are independently verified.
- The default importer excludes directors/officers.
- Public deployments are read-only by default. `sync_t3010` is exposed only with `ENABLE_T3010_SYNC=1` and then requires an exact confirmation string before writing local data.
- Retrieved/public text never determines authorization; RBAC and state transitions are server-side code requirements.
- Recipient consent is required before payment authorization.
- No banking credentials are required by the baseline architecture.

## Sources

- CRA T3010 / List of charities: Open Government Canada
- Default 2024 dataset id: `80c00cdb-1358-415c-bb8b-0de7f12675b8`
- Open Government Canada CKAN API: `https://open.canada.ca/data/api/3/action`

See [docs/T3010.md](docs/T3010.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/PRODUCTION_REQUIREMENTS.md](docs/PRODUCTION_REQUIREMENTS.md), and [PRIVACY.md](PRIVACY.md).
