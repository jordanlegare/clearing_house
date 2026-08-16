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
const result = {
  ok: organizationsWithPhone > 0,
  year,
  datasetId: manifest.datasetId,
  datasetModified: manifest.datasetModified,
  sampledRows: rows.length,
  organizationsWithPhone,
  candidateCount,
  sample,
  note: organizationsWithPhone > 0
    ? 'Public T3010 identification rows expose at least one usable phone candidate in this sample.'
    : 'No usable public phone candidates were found in the sampled identification rows; automated recipient discovery needs a separate enrichment source.'
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 2;
