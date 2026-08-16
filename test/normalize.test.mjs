import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBn, extractT3010FinancialSignals, normalizeBn, normalizeT3010Record, numericFields } from '../src/t3010/normalize.mjs';

test('normalizes Canadian registered-charity BN', () => assert.equal(normalizeBn('123 456 789 RR 0001'), '123456789RR0001'));
test('extractBn survives schema drift by scanning values', () => assert.equal(extractBn({ opaque_field: '123456789RR0001' }), '123456789RR0001'));
test('normalize record preserves all source fields', () => {
  const record = normalizeT3010Record({ kind: 'identification', rowNumber: 1, fields: { bn: '123456789RR0001', charity_name: 'Example Charity' }, resource: { id: 'r', url: 'https://example/data.csv' } });
  assert.equal(record.bn, '123456789RR0001');
  assert.equal(record.name, 'Example Charity');
  assert.equal(record.fields.charity_name, 'Example Charity');
});
test('numericFields extracts DQ-like numeric values without interpreting them', () => assert.deepEqual(numericFields({ disbursement_quota_amount: '1,250,000', note: 'x' }), { disbursement_quota_amount: 1250000 }));

test('maps line-coded T3010 financial fields to canonical signals with provenance', () => {
  const { signals, evidence } = extractT3010FinancialSignals({
    '4200': '1,500,000',
    '4350': '250000',
    '4500': '900000',
    '4700': '2,000,000',
    '4950': '1,800,000',
    '5000': '1,400,000',
    '5010': '200000',
    '5020': '100000',
    '5040': '100000',
    '5045': '50,000',
    '5050': '25,000',
    '5100': '1,875,000'
  });
  assert.deepEqual(signals, {
    totalAssets: 1500000,
    totalLiabilities: 250000,
    receiptedDonations: 900000,
    totalRevenue: 2000000,
    totalExpenditures: 1800000,
    charitableProgramExpenditures: 1400000,
    managementAdministrationExpenditures: 200000,
    fundraisingExpenditures: 100000,
    otherExpenditures: 100000,
    grantsToNonQualifiedDonees: 50000,
    giftsToQualifiedDonees: 25000,
    totalExpendituresIncludingQualifyingDisbursements: 1875000
  });
  assert.deepEqual(evidence.totalRevenue, { line: '4700', sourceKey: '4700', value: 2000000 });
  assert.deepEqual(evidence.giftsToQualifiedDonees, { line: '5050', sourceKey: '5050', value: 25000 });
});

test('financial mapper tolerates labelled line headers and ignores non-numeric values', () => {
  const { signals, evidence } = extractT3010FinancialSignals({ line_4200_total_assets: '$12,345', line_4700_total_revenue: 'not reported' });
  assert.deepEqual(signals, { totalAssets: 12345 });
  assert.equal(evidence.totalAssets.sourceKey, 'line_4200_total_assets');
  assert.equal('totalRevenue' in signals, false);
});
