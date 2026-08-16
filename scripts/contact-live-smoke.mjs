import fs from 'node:fs/promises';
import path from 'node:path';
import { ingestT3010 } from '../src/t3010/importer.mjs';
import { extractEmailCandidates, extractPhoneCandidates } from '../src/t3010/normalize.mjs';

const year = Number(process.env.T3010_YEAR || 2024);
const outputDir = path.resolve('.tmp', 'contact-live-smoke');
const maxRows = Number(process.env.CONTACT_LIVE_SMOKE_ROWS || 5000);
const manifest = await ingestT3010({ year, outputDir, resources: ['identification'], maxRows });
const text = await fs.readFile(path.join(outputDir, 'identification.jsonl'), 'utf8');
const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (!rows.length) throw new Error('Open Canada T3010 identification smoke returned zero rows.');
if (!rows.some(row => row.bn)) throw new Error('Open Canada T3010 identification smoke returned no normalized charity BNs.');

let organizationsWithPhone = 0;
let phoneCandidateCount = 0;
let organizationsWithEmail = 0;
let emailCandidateCount = 0;
let phoneSample = null;
let emailSample = null;
for (const row of rows) {
  const phones = extractPhoneCandidates(row.fields || {});
  if (phones.length) {
    organizationsWithPhone += 1;
    phoneCandidateCount += phones.length;
    if (!phoneSample) phoneSample = {
      bn: row.bn,
      keys: [...new Set(phones.map(candidate => candidate.sourceKey))],
      channels: [...new Set(phones.map(candidate => candidate.channel))]
    };
  }
  const emails = extractEmailCandidates(row.fields || {});
  if (emails.length) {
    organizationsWithEmail += 1;
    emailCandidateCount += emails.length;
    if (!emailSample) emailSample = {
      bn: row.bn,
      keys: [...new Set(emails.map(candidate => candidate.sourceKey))],
      channels: [...new Set(emails.map(candidate => candidate.channel))]
    };
  }
}

const fallbackRequired = organizationsWithPhone === 0 && organizationsWithEmail === 0;
const result = {
  ok: true,
  year,
  datasetId: manifest.datasetId,
  datasetModified: manifest.datasetModified,
  sampledRows: rows.length,
  organizationsWithPhone,
  phoneCandidateCount,
  publicPhoneCoverage: rows.length ? organizationsWithPhone / rows.length : 0,
  organizationsWithEmail,
  emailCandidateCount,
  publicEmailCoverage: rows.length ? organizationsWithEmail / rows.length : 0,
  fallbackRequired,
  phoneSample,
  emailSample,
  note: fallbackRequired
    ? 'Current sampled Open Canada T3010 identification rows expose no usable public phone or email candidates. The workflow remains fail-closed; bounded website enrichment can discover candidates, but every destination still requires proof of channel control.'
    : 'Current sampled T3010 identification rows expose at least one usable public phone or email candidate; all candidates remain untrusted until channel-control verification succeeds.'
};
console.log(JSON.stringify(result, null, 2));
