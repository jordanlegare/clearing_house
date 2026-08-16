import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { ingestT3010 } from '../src/t3010/importer.mjs';
import { T3010Repository } from '../src/t3010/repository.mjs';

function csvResponse(text) {
  const encoder = new TextEncoder();
  return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: new ReadableStream({ start(c) { c.enqueue(encoder.encode(text)); c.close(); } }) };
}

test('ingestion normalizes resources and repository searches them', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3010-'));
  const meta = {
    success: true,
    result: {
      title: 'Fixture', metadata_modified: '2026-01-01', resources: [
        { id: 'i', name: 'Identification', format: 'CSV', url: 'https://fixture/ident.csv' },
        { id: 'f', name: 'Private/Public Foundations', format: 'CSV', url: 'https://fixture/schedule_1_foundations.csv' },
        { id: 'd', name: 'Disbursement Quota', format: 'CSV', url: 'https://fixture/schedule_8_dq.csv' },
        { id: 'p', name: 'Charitable Programs', format: 'CSV', url: 'https://fixture/program.csv' }
      ]
    }
  };
  const fetchImpl = async url => {
    if (String(url).includes('package_show')) return { ok: true, json: async () => meta };
    if (String(url).endsWith('ident.csv')) return csvResponse('BN,Charity Name,Province,Designation\n111111111RR0001,Food Foundation,ON,Private foundation\n222222222RR0001,Community Food Centre,ON,Charitable organization\n');
    if (String(url).includes('foundations')) return csvResponse('BN,Foundation assets\n111111111RR0001,10000000\n222222222RR0001,0\n');
    if (String(url).includes('dq')) return csvResponse('BN,Disbursement Quota Amount\n111111111RR0001,500000\n');
    if (String(url).endsWith('program.csv')) return csvResponse('BN,Program Description\n222222222RR0001,Emergency food and community meals\n');
    throw new Error(`unexpected ${url}`);
  };
  await ingestT3010({ year: 2024, outputDir: dir, resources: ['identification','foundations','disbursement_quota','programs'], fetchImpl });
  const repo = new T3010Repository(dir); await repo.load();
  assert.equal(repo.status().charities, 2);
  assert.equal(repo.status().foundations, 1);
  assert.equal(repo.foundationProfile('111111111RR0001').disbursementQuotaNumeric.disbursement_quota_amount, 500000);
  assert.equal(repo.foundationProfile('222222222RR0001'), null);
  const hits = repo.searchCharities({ query: 'food', province: 'ON' });
  assert.equal(hits[0].bn, '222222222RR0001');
});
