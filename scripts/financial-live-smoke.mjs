import fs from 'node:fs/promises';
import path from 'node:path';
import { ingestT3010 } from '../src/t3010/importer.mjs';
import { extractT3010FinancialSignals } from '../src/t3010/normalize.mjs';

const year = Number(process.env.T3010_YEAR || 2024);
const outputDir = path.resolve('.tmp', 'financial-live-smoke');
const maxRows = Number(process.env.FINANCIAL_LIVE_SMOKE_ROWS || 500);

const manifest = await ingestT3010({
  year,
  outputDir,
  resources: ['financial_data'],
  maxRows
});

const text = await fs.readFile(path.join(outputDir, 'financial_data.jsonl'), 'utf8');
const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (!rows.length) throw new Error('Live T3010 financial smoke downloaded zero rows.');

const required = ['totalAssets', 'totalRevenue', 'totalExpenditures', 'charitableProgramExpenditures'];
const recognized = Object.fromEntries(required.map(name => [name, 0]));
let rowsWithSignals = 0;
let sample = null;

for (const row of rows) {
  const { signals, evidence } = extractT3010FinancialSignals(row.fields);
  const names = Object.keys(signals);
  if (names.length) rowsWithSignals += 1;
  for (const name of required) if (Object.prototype.hasOwnProperty.call(signals, name)) recognized[name] += 1;
  if (!sample && required.every(name => Object.prototype.hasOwnProperty.call(signals, name))) {
    sample = { bn: row.bn, signals, evidence };
  }
}

const missing = required.filter(name => recognized[name] === 0);
if (missing.length) {
  const firstKeys = Object.keys(rows[0]?.fields || {}).slice(0, 100);
  throw new Error(`Live T3010 financial schema drift: no recognized values for ${missing.join(', ')} in ${rows.length} rows. Sample keys: ${firstKeys.join(', ')}`);
}

console.log(JSON.stringify({
  ok: true,
  year,
  datasetId: manifest.datasetId,
  datasetModified: manifest.datasetModified,
  rows: rows.length,
  rowsWithSignals,
  recognized,
  sample
}, null, 2));
