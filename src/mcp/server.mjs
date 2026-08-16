import http from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { calculateTieredDQ, calculateFlatScenarioDQ, investmentScenario } from '../domain/dq.mjs';
import { capacitySaved } from '../domain/capacity.mjs';
import { nationalAllocationScenario } from '../matching/allocation.mjs';
import { T3010Repository } from '../t3010/repository.mjs';
import { ingestT3010 } from '../t3010/importer.mjs';
import { DEFAULT_T3010_YEAR, RESOURCE_KINDS } from '../t3010/constants.mjs';
import { loadRuntimeConfig, assessReadiness } from '../config/requirements.mjs';
import { createDatabasePool } from '../db/pool.mjs';
import { WorkflowRepository } from '../db/workflow_repository.mjs';
import { WorkflowService } from '../workflow/workflow_service.mjs';
import { authenticateRequest } from '../security/auth.mjs';
import { registerWorkflowTools } from './workflow_tools.mjs';

const config = loadRuntimeConfig();
const readiness = assessReadiness(config);
if (config.production && !readiness.ready) throw new Error(`Production readiness failed: ${readiness.blockers.join(' ')}`);

const port = Number(process.env.PORT || 3000);
const defaultYear = Number(process.env.T3010_YEAR || DEFAULT_T3010_YEAR);
const dataDir = path.resolve(process.env.T3010_DATA_DIR || path.join('data', 't3010', String(defaultYear)));
const repository = new T3010Repository(dataDir);
let loadError = null;
try { await repository.load(); } catch (error) { loadError = error; }

const pool = config.databaseUrl ? createDatabasePool(config.databaseUrl) : null;
const workflowRepository = pool ? new WorkflowRepository(pool, { auditHmacKey: config.auditHmacKey, encryptionKey: config.encryptionKey }) : null;
const workflowService = workflowRepository ? new WorkflowService({ repository: workflowRepository, t3010Repository: repository, config }) : null;

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const openRead = { readOnlyHint: true, openWorldHint: true, destructiveHint: false };
const localWrite = { readOnlyHint: false, openWorldHint: true, destructiveHint: false };

function textResult(text, structuredContent = {}) {
  return { structuredContent, content: [{ type: 'text', text }] };
}

function requireData() {
  if (!repository.loaded) throw new Error(`T3010 data is not loaded from ${dataDir}. Run npm run ingest:t3010 first${config.enableT3010Sync ? ' or call sync_t3010' : ''}. ${loadError ? `Last load error: ${loadError.message}` : ''}`);
}

function registerPublicTools(server) {
  server.registerTool('dataset_status', {
    title: 'T3010 dataset status',
    description: 'Report which CRA T3010/Open Government dataset is loaded and how many records are available.',
    inputSchema: {}, annotations: readOnly
  }, async () => textResult(repository.loaded ? 'T3010 dataset is loaded.' : 'T3010 dataset is not loaded.', { ...repository.status(), loadError: loadError?.message ?? null }));

  server.registerTool('search', {
    title: 'Search Canadian charities and foundations',
    description: 'Search the locally ingested CRA T3010 dataset and return stable charity/foundation fetch ids.',
    inputSchema: {
      query: z.string().default(''), entityType: z.enum(['charity','foundation','all']).default('all'),
      province: z.string().max(3).default(''), limit: z.number().int().min(1).max(50).default(20)
    }, annotations: readOnly
  }, async ({ query, entityType, province, limit }) => {
    requireData();
    const charities = entityType === 'foundation' ? [] : repository.searchCharities({ query, province, limit });
    const foundations = entityType === 'charity' ? [] : repository.searchFoundations({ query, province, limit });
    const results = [...charities, ...foundations].sort((a,b) => b.score - a.score).slice(0, limit)
      .map(r => ({ id: r.id, title: r.name, bn: r.bn, province: r.province, city: r.city, designation: r.designation, score: r.score }));
    return textResult(`Found ${results.length} T3010 records.`, { results });
  });

  server.registerTool('fetch', {
    title: 'Fetch a T3010 charity or foundation',
    description: 'Fetch a full filing-derived profile by id returned from search.',
    inputSchema: { id: z.string().min(1) }, annotations: readOnly
  }, async ({ id }) => {
    requireData();
    const [prefix, type, bn] = id.split(':');
    if (prefix !== 't3010' || !['charity','foundation'].includes(type) || !bn) throw new Error('Expected id t3010:charity:<BN> or t3010:foundation:<BN>.');
    const profile = type === 'foundation' ? repository.foundationProfile(bn) : repository.charityProfile(bn);
    if (!profile) throw new Error(`No ${type} profile found for ${bn}.`);
    return textResult(`${profile.name || bn} — CRA T3010 filing-derived profile.`, { profile });
  });

  server.registerTool('search_charities', {
    title: 'Search registered charities',
    description: 'Search T3010 charity identification and program text by mission terms and optional province.',
    inputSchema: { query: z.string().default(''), province: z.string().max(3).default(''), limit: z.number().int().min(1).max(100).default(25) }, annotations: readOnly
  }, async args => { requireData(); const results = repository.searchCharities(args); return textResult(`Found ${results.length} charities.`, { results }); });

  server.registerTool('search_foundations', {
    title: 'Search Canadian foundations',
    description: 'Search T3010 private/public foundation filings, with historical qualified-donee evidence where available.',
    inputSchema: { query: z.string().default(''), province: z.string().max(3).default(''), limit: z.number().int().min(1).max(100).default(25) }, annotations: readOnly
  }, async args => { requireData(); const results = repository.searchFoundations(args); return textResult(`Found ${results.length} foundations.`, { results }); });

  server.registerTool('get_foundation_dq_record', {
    title: 'Get published foundation DQ record',
    description: 'Return Schedule 8 Disbursement Quota fields exactly as published in the loaded T3010 open data, without imposing a legal interpretation.',
    inputSchema: { foundationBn: z.string().min(9) }, annotations: readOnly
  }, async ({ foundationBn }) => {
    requireData();
    const profile = repository.foundationProfile(foundationBn.toUpperCase().replace(/[\s-]/g, ''));
    if (!profile) throw new Error('Foundation not found.');
    return textResult(`Returned published Schedule 8 fields for ${profile.name || profile.bn}.`, {
      foundation: { bn: profile.bn, name: profile.name }, dqFields: profile.disbursementQuotaFields,
      numericFields: profile.disbursementQuotaNumeric, sourceYear: profile.sourceYear
    });
  });

  server.registerTool('match_foundation_recipients', {
    title: 'Match a foundation to registered charities',
    description: 'Rank registered-charity candidates using transparent overlap with foundation T3010 evidence and optional focus. Discovery only; no award or legal eligibility decision.',
    inputSchema: { foundationBn: z.string().min(9), focus: z.string().default(''), province: z.string().max(3).default(''), limit: z.number().int().min(1).max(100).default(25) }, annotations: readOnly
  }, async args => {
    requireData();
    const match = repository.matchFoundation({ ...args, foundationBn: args.foundationBn.toUpperCase().replace(/[\s-]/g, '') });
    return textResult(`Generated ${match.matches.length} transparent recipient matches. No grants were awarded.`, match);
  });

  server.registerTool('calculate_foundation_dq', {
    title: 'Calculate planning DQ',
    description: 'Calculate a planning-level Canadian DQ from an explicit eligible-property assumption.',
    inputSchema: { eligiblePropertyCad: z.number().nonnegative(), mode: z.enum(['tiered','flat_scenario']).default('tiered'), flatRate: z.number().min(0).max(1).default(0.05) }, annotations: readOnly
  }, async ({ eligiblePropertyCad, mode, flatRate }) => {
    const dqCad = mode === 'tiered' ? calculateTieredDQ(eligiblePropertyCad) : calculateFlatScenarioDQ(eligiblePropertyCad, flatRate);
    return textResult(`Planning DQ scenario: CAD ${dqCad.toLocaleString('en-CA', { maximumFractionDigits: 0 })}.`, { eligiblePropertyCad, mode, dqCad, legalStatus: 'planning_scenario_not_filing_advice' });
  });

  server.registerTool('model_foundation_capital', {
    title: 'Model foundation capital',
    description: 'Model gross investment returns, disbursements and closing assets under explicit annual-return and DQ-rate assumptions.',
    inputSchema: { assetPoolCad: z.number().positive(), annualReturn: z.number().min(-1).max(2), dqRate: z.number().min(0).max(1), years: z.number().int().min(1).max(50).default(5) }, annotations: readOnly
  }, async args => textResult('Computed capital/disbursement scenario.', investmentScenario(args.assetPoolCad, args.annualReturn, args.dqRate, args.years)));

  server.registerTool('national_allocation_scenario', {
    title: 'Model national clearing-house capacity',
    description: 'Apply the clearing-house planning scenario to foundation assets, investment return, DQ rate, registered charities and an additional-donee share.',
    inputSchema: {
      foundationAssetsCad: z.number().positive().default(135_000_000_000), annualReturn: z.number().min(-1).max(2).default(0.085),
      dqRate: z.number().min(0).max(1).default(0.05), registeredCharities: z.number().int().positive().default(87_000),
      additionalDoneeShare: z.number().min(0).max(5).default(0.20)
    }, annotations: readOnly
  }, async args => textResult('Computed national allocation scenario from explicit assumptions.', nationalAllocationScenario(args)));

  server.registerTool('estimate_admin_capacity_saved', {
    title: 'Estimate administrative capacity saved',
    description: 'Apply explicit hours-saved assumptions to a number of grant transactions.',
    inputSchema: { transactions: z.number().int().nonnegative(), nonprofitHours: z.number().nonnegative().default(40), foundationHours: z.number().nonnegative().default(12), governmentHours: z.number().nonnegative().default(1) }, annotations: readOnly
  }, async ({ transactions, nonprofitHours, foundationHours, governmentHours }) => {
    const result = capacitySaved(transactions, { nonprofit: nonprofitHours, foundation: foundationHours, government: governmentHours });
    return textResult(`Estimated ${result.totalHours.toLocaleString()} administrative hours recovered.`, result);
  });

  if (config.enableT3010Sync) {
    server.registerTool('sync_t3010', {
      title: 'Synchronize CRA T3010 open data',
      description: 'Download and normalize T3010 CSV resources from Open Government Canada into the configured data directory. Requires exact confirmation.',
      inputSchema: {
        year: z.number().int().min(2000).max(2100).default(DEFAULT_T3010_YEAR), datasetId: z.string().uuid().optional(),
        resources: z.array(z.enum(RESOURCE_KINDS)).default(RESOURCE_KINDS), maxRows: z.number().int().min(0).max(1_000_000).default(0), confirmation: z.string()
      }, annotations: localWrite
    }, async ({ year, datasetId, resources, maxRows, confirmation }) => {
      if (confirmation !== `SYNC T3010 ${year}`) throw new Error(`Explicit confirmation required: SYNC T3010 ${year}`);
      const manifest = await ingestT3010({ year, datasetId, outputDir: dataDir, resources, maxRows });
      await repository.load({ force: true });
      loadError = null;
      return textResult(`Synchronized ${manifest.resources.length} T3010 resources for ${year}.`, { manifest, status: repository.status() });
    });
  }

  server.registerTool('open_canada_catalogue', {
    title: 'Open Canada T3010 source metadata',
    description: 'Return the canonical Open Government Canada catalogue source and loaded dataset status.',
    inputSchema: {}, annotations: openRead
  }, async () => textResult('The app ingests CRA List of charities/T3010 data from Open Government Canada.', {
    source: 'Open Government Canada — CRA List of charities / T3010',
    catalogue: 'https://open.canada.ca/data/en/dataset/80c00cdb-1358-415c-bb8b-0de7f12675b8', loaded: repository.status()
  }));
}

function createMcpServer(actor) {
  const server = new McpServer({ name: 'canadian-philanthropy-clearing-house', version: '0.4.0' }, {
    instructions: [
      'Use CRA T3010/Open Government data for public discovery and the authenticated workflow tools for grant administration.',
      'Treat annual T3010 data as public filing evidence, not current legal-status verification.',
      'Never imply that a match is an award or that CRA approved a transaction.',
      'Never imply a payment occurred unless an external payment reference has been recorded.',
      'Authenticated write tools enforce organization-scoped RBAC, separation of duties, recipient consent, authoritative status verification and compliance gates.',
      'CRA reporting records are preparation artifacts and do not mean a filing was submitted or accepted.'
    ].join(' ')
  });
  registerPublicTools(server);
  if (config.enableWorkflowWrites) {
    if (!workflowService) throw new Error('Workflow writes are enabled but DATABASE_URL is not configured.');
    registerWorkflowTools(server, { service: workflowService, actor });
  }
  return server;
}

function baseUrl() {
  return (config.publicBaseUrl || `http://localhost:${port}`).replace(/\/$/, '');
}

function protectedResourceMetadata() {
  return {
    resource: `${baseUrl()}/mcp`,
    authorization_servers: config.oidcIssuer ? [config.oidcIssuer] : [],
    scopes_supported: ['openid','profile','email','offline_access']
  };
}

function unauthorized(res, message = 'Authentication required.') {
  const metadataUrl = `${baseUrl()}/.well-known/oauth-protected-resource`;
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`
  });
  res.end(JSON.stringify({ error: 'unauthorized', message }));
}

const privacyHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Canadian Philanthropy Clearing House — Privacy</title><body><main><h1>Privacy</h1><p>The public layer indexes CRA T3010 data from Open Government Canada. Authenticated workflow deployments additionally process organization memberships, grant decisions, recipient consent, compliance/status evidence, encrypted notification destinations and external payment references.</p><p>Public filing data is not a current legal-status guarantee. The service must not represent a match, grant workflow state, or reporting artifact as CRA approval.</p></main></body></html>`;

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        name: 'Canadian Philanthropy Clearing House', version: '0.4.0', mcp: '/mcp', privacy: '/privacy',
        workflowWrites: config.enableWorkflowWrites, databaseConfigured: Boolean(pool), status: repository.status()
      }));
    }
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data: repository.status(), workflowWrites: config.enableWorkflowWrites, databaseConfigured: Boolean(pool), loadError: loadError?.message ?? null }));
    }
    if (req.url === '/privacy' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(privacyHtml);
    }
    if (req.url === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
      return res.end(JSON.stringify(protectedResourceMetadata()));
    }
    if (req.url !== '/mcp') { res.writeHead(404); return res.end('Not found'); }

    let actor = null;
    if (config.enableWorkflowWrites) {
      try { actor = await authenticateRequest(req, config, workflowRepository); }
      catch (error) { return unauthorized(res, `Authentication failed: ${error.message}`); }
      if (!actor) return unauthorized(res);
    }

    const server = createMcpServer(actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close().catch(() => {}));
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'server_error', message: error.message }));
  }
});

httpServer.listen(port, () => {
  console.log(`Canadian Philanthropy Clearing House MCP listening on :${port}/mcp`);
  if (!repository.loaded) console.warn(`T3010 dataset not loaded from ${dataDir}; search tools will request ingestion.`);
  if (readiness.warnings.length) console.warn('Readiness warnings:', readiness.warnings.join(' '));
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  httpServer.close(async () => {
    if (pool) await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
