import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResource, discoverT3010Resources, fetchOpenCanadaPackage } from '../src/t3010/catalog.mjs';

const resources = [
  { id: '1', name: 'Identification', format: 'CSV', url: 'https://example/ident_2024_updated.csv' },
  { id: '2', name: 'Private/Public Foundations', format: 'CSV', url: 'https://example/schedule_1_foundations_2024.csv' },
  { id: '3', name: 'Disbursement Quota', format: 'CSV', url: 'https://example/schedule_8_dq_2024.csv' },
  { id: '4', name: 'Non-Qualified donees', format: 'CSV', url: 'https://example/non_qualified_donees_2024.csv' },
  { id: '5', name: 'Qualified donees', format: 'CSV', url: 'https://example/qualified_donees_2024.csv' }
];

test('resource classifier distinguishes qualified vs non-qualified donees', () => {
  assert.equal(classifyResource(resources[3]), 'non_qualified_donees');
  assert.equal(classifyResource(resources[4]), 'qualified_donees');
});

test('resource discovery locates core T3010 resources', () => {
  const found = discoverT3010Resources({ resources });
  assert.equal(found.identification.id, '1');
  assert.equal(found.foundations.id, '2');
  assert.equal(found.disbursement_quota.id, '3');
});

test('catalogue fetch uses the public CKAN package_show endpoint', async () => {
  let requested = '';
  const fetchImpl = async url => {
    requested = url;
    return { ok: true, json: async () => ({ success: true, result: { title: '2024 List of charities', resources } }) };
  };
  const result = await fetchOpenCanadaPackage({ year: 2024, fetchImpl });
  assert.match(requested, /open\.canada\.ca\/data\/api\/3\/action\/package_show\?id=/);
  assert.equal(result.package.title, '2024 List of charities');
});
