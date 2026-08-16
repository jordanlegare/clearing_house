import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBn, normalizeBn, normalizeT3010Record, numericFields } from '../src/t3010/normalize.mjs';

test('normalizes Canadian registered-charity BN', () => assert.equal(normalizeBn('123 456 789 RR 0001'), '123456789RR0001'));
test('extractBn survives schema drift by scanning values', () => assert.equal(extractBn({ opaque_field: '123456789RR0001' }), '123456789RR0001'));
test('normalize record preserves all source fields', () => {
  const record = normalizeT3010Record({ kind: 'identification', rowNumber: 1, fields: { bn: '123456789RR0001', charity_name: 'Example Charity' }, resource: { id: 'r', url: 'https://example/data.csv' } });
  assert.equal(record.bn, '123456789RR0001');
  assert.equal(record.name, 'Example Charity');
  assert.equal(record.fields.charity_name, 'Example Charity');
});
test('numericFields extracts DQ-like numeric values without interpreting them', () => assert.deepEqual(numericFields({ disbursement_quota_amount: '1,250,000', note: 'x' }), { disbursement_quota_amount: 1250000 }));
