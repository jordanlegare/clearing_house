#!/usr/bin/env node
import path from 'node:path';
import { ingestT3010 } from '../src/t3010/importer.mjs';
import { DEFAULT_T3010_YEAR, RESOURCE_KINDS } from '../src/t3010/constants.mjs';

function parseArgs(argv) {
  const out = { year: DEFAULT_T3010_YEAR, resources: RESOURCE_KINDS, maxRows: 0, datasetId: undefined, outputDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--year') out.year = Number(next());
    else if (arg === '--dataset-id') out.datasetId = next();
    else if (arg === '--resources') out.resources = next().split(',').map(v => v.trim()).filter(Boolean);
    else if (arg === '--max-rows') out.maxRows = Number(next());
    else if (arg === '--output') out.outputDir = path.resolve(next());
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: npm run ingest:t3010 -- [options]\n\n` +
    `  --year 2024                 T3010 catalogue year (default: 2024)\n` +
    `  --dataset-id <uuid>         Override Open Canada CKAN dataset id\n` +
    `  --resources a,b,c          Resource kinds to ingest\n` +
    `  --max-rows N               Limit data rows per resource; 0 means all\n` +
    `  --output <dir>              Output directory (default data/t3010/<year>)\n` +
    `\nResource kinds: ${RESOURCE_KINDS.join(', ')}\n`);
  process.exit(0);
}

const manifest = await ingestT3010({
  year: args.year,
  datasetId: args.datasetId,
  resources: args.resources,
  maxRows: args.maxRows,
  outputDir: args.outputDir ?? path.resolve('data', 't3010', String(args.year)),
  onProgress(event) {
    if (event.phase === 'resource_start') console.error(`-> ${event.kind}`);
    if (event.phase === 'resource_complete') console.error(`   ${event.rows.toLocaleString()} rows (${event.rowsWithBusinessNumber.toLocaleString()} with BN)`);
  }
});
console.log(JSON.stringify(manifest, null, 2));
