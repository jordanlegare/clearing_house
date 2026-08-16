import fs from 'node:fs/promises';
import path from 'node:path';
import { ingestT3010 } from '../src/t3010/importer.mjs';
import { deriveSchedule8Evidence } from '../src/domain/dq_evidence.mjs';

const year = Number(process.env.T3010_YEAR || 2024);
const outputDir = path.resolve('.tmp', 'dq-live-smoke');
const maxRows = Number(process.env.DQ_LIVE_SMOKE_ROWS || 500);

const manifest = await ingestT3010({
  year,
  outputDir,
  resources: ['disbursement_quota'],
  maxRows
});
const text = await fs.readFile(path.join(outputDir, 'disbursement_quota.jsonl'), 'utf8');
const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
let currentRecognized = 0;
let nextRecognized = 0;
let sample = null;
for (const row of rows) {
  const evidence = deriveSchedule8Evidence({
    bn: row.bn,
    name: row.name,
    sourceYear: year,
    disbursementQuotaFields: row.fields
  });
  if (evidence.current.line840DqRequirementCad != null) currentRecognized += 1;
  if (evidence.next.line870PropertyCad != null || evidence.next.estimatedDqCad != null) nextRecognized += 1;
  if (!sample && evidence.current.line840DqRequirementCad != null) {
    sample = {
      bn: row.bn,
      evidence,
      sourceKeys: Object.keys(row.fields).filter(key => /(^|[^0-9])(840|870|875|890)([^0-9]|$)/.test(key)).slice(0, 20)
    };
  }
}
if (!rows.length) throw new Error('Live Schedule 8 smoke downloaded zero rows.');
if (currentRecognized === 0) {
  const firstKeys = Object.keys(rows[0]?.fields || {}).slice(0, 80);
  throw new Error(`Live Schedule 8 schema drift: no line 840 value recognized in ${rows.length} rows. Sample keys: ${firstKeys.join(', ')}`);
}
if (nextRecognized === 0) {
  const firstKeys = Object.keys(rows[0]?.fields || {}).slice(0, 80);
  throw new Error(`Live Schedule 8 schema drift: no next-period line 870/875/890 evidence recognized in ${rows.length} rows. Sample keys: ${firstKeys.join(', ')}`);
}
console.log(JSON.stringify({
  ok: true,
  year,
  datasetId: manifest.datasetId,
  datasetModified: manifest.datasetModified,
  rows: rows.length,
  currentRecognized,
  nextRecognized,
  sample
}, null, 2));
