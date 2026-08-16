import fs from 'node:fs/promises';
import path from 'node:path';
import { ingestT3010 } from '../src/t3010/importer.mjs';
import { extractPhoneCandidates } from '../src/t3010/normalize.mjs';

const year = Number(process.env.T3010_YEAR || 2024);
const outputDir = path.resolve('.tmp', 'contact-live-smoke');
const maxRows = Number(process.env.CONTACT_LIVE_SMOKE_ROWS || 5000);
const manifest = await ingestT3010({ year, outputDir, resources: ['identification'], maxRows });
const text = await fs.readFile(path.join(outputDir, 'identification.jsonl'), 'utf8');
const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (!rows.length) throw new Error('Open Canada T3010 identification smoke returned zero rows.');
if (!rows.some(row => row.bn)) throw new Error('Open Canada T3010 identification smoke returned no normalized charity BNs.');

let organizationsWithPhone = 0;
let candidateCount = 0;
let sample = null;
for (const row of rows) {
  const candidates = extractPhoneCandidates(row.fields || {});
  if (!candidates.length) continue;
  organizationsWithPhone += 1;
  candidateCount += candidates.length;
  if (!sample) sample = {
    bn: row.bn,
    keys: [...new Set(candidates.map(candidate => candidate.sourceKey))],
    channels: [...new Set(candidates.map(candidate => candidate.channel))]
  };
}

const fallbackRequired = organizationsWithPhone === 0;
const result = {
  ok: true,
  year,
  datasetId: manifest.datasetId,
  datasetModified: manifest.datasetModified,
  sampledRows: rows.length,
  organizationsWithPhone,
  candidateCount,
  publicPhoneCoverage: rows.length ? organizationsWithPhone / rows.length : 0,
  fallbackRequired,
  sample,
  note: fallbackRequired
    ? 'Current sampled Open Canada T3010 identification rows expose no usable public phone candidates. The grant workflow remains fail-closed and requires a verified contact from another approved source; website/contact enrichment is the next fallback path.'
    : 'Public T3010 identification rows expose at least one usable phone candidate in this sample.'
};
console.log(JSON.stringify(result, null, 2));
