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
        { id: 'p', name: 'Charitable Programs', format: 'CSV', url: 'https://fixture/program.csv' },
        { id: 'fin', name: 'Financial Data', format: 'CSV', url: 'https://fixture/financial.csv' }
      ]
    }
  };
  const fetchImpl = async url => {
    if (String(url).includes('package_show')) return { ok: true, json: async () => meta };
    if (String(url).endsWith('ident.csv')) return csvResponse('BN,Charity Name,Province,Designation\n111111111RR0001,Public Food Foundation,ON,A\n333333333RR0001,Private Food Foundation,ON,B\n222222222RR0001,Community Food Centre,ON,C\n');
    if (String(url).includes('foundations')) return csvResponse('BN,Foundation assets\n111111111RR0001,10000000\n333333333RR0001,5000000\n222222222RR0001,0\n');
    if (String(url).includes('dq')) return csvResponse('BN,Disbursement Quota Amount\n111111111RR0001,500000\n333333333RR0001,250000\n');
    if (String(url).endsWith('program.csv')) return csvResponse('BN,Program Description\n222222222RR0001,Emergency food and community meals\n');
    if (String(url).endsWith('financial.csv')) return csvResponse('BN,4200,4350,4500,4700,4950,5000,5010,5020,5040,5045,5050,5100\n111111111RR0001,10000000,500000,750000,1200000,1000000,600000,150000,100000,150000,25000,100000,1125000\n222222222RR0001,2500000,300000,1750000,2000000,1900000,1600000,150000,100000,50000,0,0,1900000\n');
    throw new Error(`unexpected ${url}`);
  };
  await ingestT3010({ year: 2024, outputDir: dir, resources: ['identification','foundations','disbursement_quota','programs','financial_data'], fetchImpl });
  const repo = new T3010Repository(dir); await repo.load();
  assert.equal(repo.status().charities, 3);
  assert.equal(repo.status().foundations, 2);
  assert.equal(repo.status().financialRecords, 2);
  assert.equal(repo.foundationProfile('111111111RR0001').disbursementQuotaNumeric.disbursement_quota_amount, 500000);
  assert.equal(repo.foundationProfile('333333333RR0001').disbursementQuotaNumeric.disbursement_quota_amount, 250000);
  assert.equal(repo.foundationProfile('222222222RR0001'), null);
  const charity = repo.charityProfile('222222222RR0001');
  assert.equal(charity.financialSignals.totalAssets, 2500000);
  assert.equal(charity.financialSignals.totalRevenue, 2000000);
  assert.equal(charity.financialSignals.charitableProgramExpenditures, 1600000);
  assert.deepEqual(charity.financialSignalEvidence.totalRevenue, { line: '4700', sourceKey: '4700', value: 2000000 });
  assert.equal(charity.financialSource.sourceResourceId, 'fin');
  const hits = repo.searchCharities({ query: 'food', province: 'ON' });
  assert.equal(hits[0].bn, '222222222RR0001');
  assert.equal(hits[0].financialSignals.totalRevenue, 2000000);
});
