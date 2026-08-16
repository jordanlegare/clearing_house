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

const port = Number(process.env.PORT || 3000);
const defaultYear = Number(process.env.T3010_YEAR || DEFAULT_T3010_YEAR);
const dataDir = path.resolve(process.env.T3010_DATA_DIR || path.join('data', 't3010', String(defaultYear)));
const repository = new T3010Repository(dataDir);
let loadError = null;
try { await repository.load(); } catch (error) { loadError = error; }

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const openRead = { readOnlyHint: true, openWorldHint: true, destructiveHint: false };
const localWrite = { readOnlyHint: false, openWorldHint: true, destructiveHint: false };

function textResult(text, structuredContent = {}) {
  return { structuredContent, content: [{ type: 'text', text }] };
}

function requireData() {
  if (!repository.loaded) throw new Error(`T3010 data is not loaded from ${dataDir}. Run npm run ingest:t3010 first${process.env.ENABLE_T3010_SYNC === '1' ? ' or call sync_t3010' : ''}. ${loadError ? `Last load error: ${loadError.message}` : ''}`);
}

function createMcpServer() {
  const server = new McpServer({ name: 'canadian-philanthropy-clearing-house', version: '0.2.0' }, {
    instructions: [
      'Use CRA T3010/Open Government data to locate Canadian registered charities and foundations and to explain published records.',
      'Treat T3010 data as self-reported public filing data, not a legal determination of eligibility or current registration status.',
      'Never imply that a proposed match is an award, that money moved, or that CRA approved a transaction.',
      'DQ calculators are planning scenarios unless the exact statutory inputs and current CRA rules are independently verified.',
      'Prefer transparent matching reasons and published filing evidence over opaque impact rankings.'
    ].join(' ')
  });

  server.registerTool('dataset_status', {
    title: 'T3010 dataset status',
    description: 'Report which CRA T3010/Open Government dataset is loaded and how many records are available.',
    inputSchema: {}, annotations: readOnly
  }, async () => textResult(repository.loaded ? 'T3010 dataset is loaded.' : 'T3010 dataset is not loaded.', { ...repository.status(), loadError: loadError?.message ?? null }));

  server.registerTool('search', {
    title: 'Search Canadian charities and foundations',
    description: 'Search the locally ingested CRA T3010 dataset. Returns registered-charity or foundation filing profiles and stable fetch ids.',
    inputSchema: {
      query: z.string().default(''),
      entityType: z.enum(['charity', 'foundation', 'all']).default('all'),
      province: z.string().max(3).default(''),
      limit: z.number().int().min(1).max(50).default(20)
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
    description: 'Fetch a full filing-derived profile by id returned from search, e.g. t3010:charity:<BN> or t3010:foundation:<BN>.',
    inputSchema: { id: z.string().min(1) }, annotations: readOnly
  }, async ({ id }) => {
    requireData();
    const parts = id.split(':');
    if (parts.length !== 3 || parts[0] !== 't3010') throw new Error('Expected id t3010:charity:<BN> or t3010:foundation:<BN>');
    const [, type, bn] = parts;
    const profile = type === 'foundation' ? repository.foundationProfile(bn) : repository.charityProfile(bn);
    if (!profile) throw new Error(`No ${type} profile found for ${bn}`);
    return textResult(`${profile.name || bn} — CRA T3010 filing-derived profile.`, { profile });
  });

  server.registerTool('search_charities', {
    title: 'Search registered charities',
    description: 'Search T3010 charity identification and program text by mission terms and optional province.',
    inputSchema: { query: z.string().default(''), province: z.string().max(3).default(''), limit: z.number().int().min(1).max(100).default(25) },
    annotations: readOnly
  }, async (args) => { requireData(); const results = repository.searchCharities(args); return textResult(`Found ${results.length} charities.`, { results }); });

  server.registerTool('search_foundations', {
    title: 'Search Canadian foundations',
    description: 'Search T3010 private/public foundation filings, with historical qualified-donee evidence where available.',
    inputSchema: { query: z.string().default(''), province: z.string().max(3).default(''), limit: z.number().int().min(1).max(100).default(25) },
    annotations: readOnly
  }, async (args) => { requireData(); const results = repository.searchFoundations(args); return textResult(`Found ${results.length} foundations.`, { results }); });

  server.registerTool('get_foundation_dq_record', {
    title: 'Get published foundation DQ record',
    description: 'Return the foundation Schedule 8 Disbursement Quota row as published in the loaded T3010 Open Government data, including numeric-looking DQ/property/amount fields without imposing a legal interpretation.',
    inputSchema: { foundationBn: z.string().min(9) }, annotations: readOnly
  }, async ({ foundationBn }) => {
    requireData();
    const profile = repository.foundationProfile(foundationBn.toUpperCase().replace(/[\s-]/g, ''));
    if (!profile) throw new Error('Foundation not found');
    return textResult(`Returned published Schedule 8 fields for ${profile.name || profile.bn}.`, { foundation: { bn: profile.bn, name: profile.name }, dqFields: profile.disbursementQuotaFields, numericFields: profile.disbursementQuotaNumeric, sourceYear: profile.sourceYear });
  });

  server.registerTool('match_foundation_recipients', {
    title: 'Match a foundation to registered charities',
    description: 'Rank registered-charity candidates using transparent overlap with the foundation’s T3010 filing/history and an optional user-supplied focus. This is discovery, not an award or legal eligibility decision.',
    inputSchema: {
      foundationBn: z.string().min(9),
      focus: z.string().default(''),
      province: z.string().max(3).default(''),
      limit: z.number().int().min(1).max(100).default(25)
    }, annotations: readOnly
  }, async (args) => { requireData(); const result = repository.matchFoundation({ ...args, foundationBn: args.foundationBn.toUpperCase().replace(/[\s-]/g, '') }); return textResult(`Generated ${result.matches.length} transparent recipient matches. No grants were awarded.`, result); });

  server.registerTool('calculate_foundation_dq', {
    title: 'Calculate planning DQ',
    description: 'Calculate a planning-level Canadian DQ from an explicit eligible-property assumption. Use published Schedule 8 separately for filing data.',
    inputSchema: {
      eligiblePropertyCad: z.number().nonnegative(),
      mode: z.enum(['tiered', 'flat_scenario']).default('tiered'),
      flatRate: z.number().min(0).max(1).default(0.05)
    }, annotations: readOnly
  }, async ({ eligiblePropertyCad, mode, flatRate }) => {
    const dqCad = mode === 'tiered' ? calculateTieredDQ(eligiblePropertyCad) : calculateFlatScenarioDQ(eligiblePropertyCad, flatRate);
    return textResult(`Planning DQ scenario: CAD ${dqCad.toLocaleString('en-CA', { maximumFractionDigits: 0 })}.`, { eligiblePropertyCad, mode, dqCad, legalStatus: 'planning_scenario_not_filing_advice' });
  });

  server.registerTool('model_foundation_capital', {
    title: 'Model foundation capital',
    description: 'Model gross investment returns, disbursements and closing assets under explicit annual-return and DQ-rate assumptions.',
    inputSchema: { assetPoolCad: z.number().positive(), annualReturn: z.number().min(-1).max(2), dqRate: z.number().min(0).max(1), years: z.number().int().min(1).max(50).default(5) }, annotations: readOnly
  }, async (args) => textResult('Computed capital/disbursement scenario.', investmentScenario(args.assetPoolCad, args.annualReturn, args.dqRate, args.years)));

  server.registerTool('national_allocation_scenario', {
    title: 'Model national clearing-house capacity',
    description: 'Apply the clearing-house planning scenario to foundation assets, investment return, DQ rate, registered charities and an additional-donee share.',
    inputSchema: {
      foundationAssetsCad: z.number().positive().default(135_000_000_000),
      annualReturn: z.number().min(-1).max(2).default(0.085),
      dqRate: z.number().min(0).max(1).default(0.05),
      registeredCharities: z.number().int().positive().default(87_000),
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

  // Network/write mutation is opt-in. Public deployments are read-only by default.
  if (process.env.ENABLE_T3010_SYNC === '1') {
    server.registerTool('sync_t3010', {
      title: 'Synchronize CRA T3010 open data',
      description: 'Download and normalize T3010 CSV resources from Open Government Canada into this server. Requires exact confirmation and writes only to the configured local T3010 data directory.',
      inputSchema: {
        year: z.number().int().min(2000).max(2100).default(DEFAULT_T3010_YEAR),
        datasetId: z.string().uuid().optional(),
        resources: z.array(z.enum(RESOURCE_KINDS)).default(RESOURCE_KINDS),
        maxRows: z.number().int().min(0).max(1_000_000).default(0),
        confirmation: z.string()
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
    description: 'Return the canonical Open Government Canada catalogue URL and source-year status used by this plugin.',
    inputSchema: {}, annotations: openRead
  }, async () => textResult('The plugin ingests CRA List of charities/T3010 data from Open Government Canada.', {
    source: 'Open Government Canada — CRA List of charities / T3010',
    catalogue: 'https://open.canada.ca/data/en/dataset/80c00cdb-1358-415c-bb8b-0de7f12675b8',
    loaded: repository.status()
  }));

  return server;
}

const privacyHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Canadian Philanthropy Clearing House — Privacy</title><body><main><h1>Privacy</h1><p>This service indexes public CRA T3010 data obtained from Open Government Canada. The default ingestion excludes directors/officers data. Search and matching requests are processed to answer the request; the reference implementation does not intentionally persist ChatGPT conversation text.</p><p>Do not use the service to infer sensitive traits, automate adverse decisions, or treat a match as a legal eligibility determination. Production deployments must publish operator-specific retention, security, contact, and subprocessors information before public use.</p></main></body></html>`;

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ name: 'Canadian Philanthropy Clearing House', version: '0.2.0', mcp: '/mcp', privacy: '/privacy', status: repository.status() }));
  }
  if (req.url === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, data: repository.status(), loadError: loadError?.message ?? null }));
  }
  if (req.url === '/privacy' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(privacyHtml);
  }
  if (req.url !== '/mcp') { res.writeHead(404); return res.end('Not found'); }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(port, () => {
  console.log(`Canadian Philanthropy Clearing House MCP listening on :${port}/mcp`);
  if (!repository.loaded) console.warn(`T3010 dataset not loaded from ${dataDir}; search tools will request ingestion.`);
});
