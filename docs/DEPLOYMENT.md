# Deployment and ChatGPT connection

## 1. Ingest CRA T3010 data

```bash
npm install
npm run ingest:t3010 -- --year 2024
```

The importer discovers the current CSV URLs from Open Government Canada's CKAN package metadata and streams them into `data/t3010/2024/*.jsonl`.

For a smoke run:

```bash
npm run ingest:t3010 -- --year 2024 \
  --resources identification,foundations,disbursement_quota \
  --max-rows 100 --output .tmp/t3010-smoke
```

## 2. Run the MCP server

```bash
T3010_YEAR=2024 PORT=3000 npm start

# Optional only for a controlled operator deployment:
# ENABLE_T3010_SYNC=1 T3010_YEAR=2024 PORT=3000 npm start
```

Endpoints:

- `GET /healthz`
- `GET /privacy`
- MCP Streamable HTTP: `/mcp`

## 3. Deploy remotely

ChatGPT connects to a remote MCP endpoint. Deploy the Docker image to a TLS-enabled host and persist `data/t3010` on a volume or ingest it during a release job.

## 4. Connect in ChatGPT

In ChatGPT developer/custom-app settings, create an app and provide the remote MCP endpoint, for example:

`https://clearing-house.example.ca/mcp`

Scan the tools, review read/write annotations, and test the app before publishing. Production deployments should add OAuth/OIDC and operator-specific privacy/security controls.
