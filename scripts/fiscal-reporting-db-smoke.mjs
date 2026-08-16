import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import {
  getFiscalReportingPackage,
  prepareFiscalReportingPackage,
  previewFiscalReportingPackage,
  setGrantReportingMetadata
} from '../src/compliance/fiscal_package.mjs';

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.ENCRYPTION_KEY;
const auditHmacKey = process.env.AUDIT_HMAC_KEY;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { encryptionKey, auditHmacKey });

async function grant({ foundationId, recipientId, recipientType, amountCad, purpose, recordedAt, suffix }) {
  const row = (await pool.query(`
    INSERT INTO grants (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,creation_idempotency_key)
    VALUES ($1,$2,$3,$4,$5,'paid',$6) RETURNING id
  `, [foundationId, recipientId, amountCad, purpose, recipientType, `fiscal-smoke-grant-${suffix}`])).rows[0];
  await pool.query(`
    INSERT INTO payment_intents (grant_id,provider,amount_cad,status,external_reference,recorded_at)
    VALUES ($1,'manual',$2,'recorded',$3,$4)
  `, [row.id, amountCad, `external-${suffix}`, recordedAt]);
  return row.id;
}

try {
  const analyst = (await pool.query(`
    INSERT INTO users (oidc_subject,email,display_name)
    VALUES ('fiscal-reporting-analyst','fiscal@example.test','Fiscal Reporting Analyst') RETURNING id
  `)).rows[0];
  const foundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province,public_profile)
    VALUES ('888888888RR0001','Fiscal Package Foundation','foundation','ON','{}'::jsonb) RETURNING id
  `)).rows[0];
  const qd = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province,public_profile)
    VALUES ('999999999RR0001','Grouped Qualified Donee','registered_charity','ON',$1::jsonb) RETURNING id
  `, [JSON.stringify({ city: 'Ottawa', country: 'Canada' })])).rows[0];
  const smallNqd = (await pool.query(`
    INSERT INTO organizations (legal_name,organization_type,province,public_profile)
    VALUES ('Small Canadian Grantee','nqd','ON',$1::jsonb) RETURNING id
  `, [JSON.stringify({ city: 'Toronto', country: 'Canada' })])).rows[0];
  const largeNqd = (await pool.query(`
    INSERT INTO organizations (legal_name,organization_type,public_profile)
    VALUES ('Large International Grantee','nqd',$1::jsonb) RETURNING id
  `, [JSON.stringify({ country: 'United States' })])).rows[0];
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_analyst')`, [analyst.id, foundation.id]);
  const actor = { id: analyst.id, subject: 'fiscal-reporting-analyst', roles: [], memberships: [{ organizationId: foundation.id, role: 'foundation_analyst' }] };

  const qd1 = await grant({ foundationId: foundation.id, recipientId: qd.id, recipientType: 'qualified_donee', amountCad: '1000.00', purpose: 'Community services', recordedAt: '2026-02-15T12:00:00Z', suffix: 'qd-1' });
  const qd2 = await grant({ foundationId: foundation.id, recipientId: qd.id, recipientType: 'qualified_donee', amountCad: '1500.00', purpose: 'Community services', recordedAt: '2026-06-20T12:00:00Z', suffix: 'qd-2' });
  const small = await grant({ foundationId: foundation.id, recipientId: smallNqd.id, recipientType: 'non_qualified_donee', amountCad: '4000.00', purpose: 'Local food security', recordedAt: '2026-03-10T12:00:00Z', suffix: 'nqd-small' });
  const large1 = await grant({ foundationId: foundation.id, recipientId: largeNqd.id, recipientType: 'non_qualified_donee', amountCad: '3000.00', purpose: 'International health services', recordedAt: '2026-04-10T12:00:00Z', suffix: 'nqd-large-1' });
  const large2 = await grant({ foundationId: foundation.id, recipientId: largeNqd.id, recipientType: 'non_qualified_donee', amountCad: '3500.00', purpose: 'International health services', recordedAt: '2026-08-10T12:00:00Z', suffix: 'nqd-large-2' });
  await grant({ foundationId: foundation.id, recipientId: qd.id, recipientType: 'qualified_donee', amountCad: '9000.00', purpose: 'Prior-period gift', recordedAt: '2025-12-31T12:00:00Z', suffix: 'outside-period' });

  const incomplete = await previewFiscalReportingPackage(repository, actor, {
    foundationOrgId: foundation.id,
    fiscalPeriodStart: '2026-01-01',
    fiscalPeriodEnd: '2026-12-31'
  });
  assert.equal(incomplete.filingReady, false);
  assert.ok(incomplete.reviewFlags.some(flag => flag.code === 'associated_charity_not_confirmed'));
  assert.ok(incomplete.reviewFlags.some(flag => flag.code === 'nqd_activity_location_not_confirmed'));
  assert.equal(incomplete.ledger.paidGrantCount, 5, 'prior-period payment must be excluded');

  await setGrantReportingMetadata(repository, actor, { grantId: qd1, associatedCharity: false, idempotencyKey: 'fiscal-meta-qd-1' });
  await setGrantReportingMetadata(repository, actor, { grantId: qd2, associatedCharity: false, idempotencyKey: 'fiscal-meta-qd-2' });
  await setGrantReportingMetadata(repository, actor, { grantId: small, activitiesOutsideCanada: false, idempotencyKey: 'fiscal-meta-small' });
  await setGrantReportingMetadata(repository, actor, { grantId: large1, activitiesOutsideCanada: true, countries: ['US-United States'], idempotencyKey: 'fiscal-meta-large-1' });
  await setGrantReportingMetadata(repository, actor, { grantId: large2, activitiesOutsideCanada: true, countries: ['US-United States'], idempotencyKey: 'fiscal-meta-large-2' });

  const ready = await previewFiscalReportingPackage(repository, actor, {
    foundationOrgId: foundation.id,
    fiscalPeriodStart: '2026-01-01',
    fiscalPeriodEnd: '2026-12-31'
  });
  assert.equal(ready.filingReady, true, JSON.stringify(ready.reviewFlags));
  assert.equal(ready.reviewFlags.length, 0);
  assert.equal(ready.t3010.questionC3QualifiedDoneeGifts, true);
  assert.equal(ready.t3010.line5840NqdGrants, true);
  assert.equal(ready.t3010.line5841AnyNqdOver5000, true);
  assert.equal(ready.t3010.line5842NqdCountAtOrBelow5000, 1);
  assert.equal(ready.t3010.line5843NqdAmountAtOrBelow5000Cad, 4000);
  assert.equal(ready.t3010.line5045NqdGrantsCad, 10500);
  assert.equal(ready.t3010.line5050QualifiedDoneeGiftsCad, 2500);
  assert.equal(ready.t1236.totalOrganizations, 1);
  assert.equal(ready.t1236.rows[0].totalGiftsCad, '2500.00');
  assert.equal(ready.t1236.rows[0].businessNumber, '999999999RR0001');
  assert.equal(ready.t1441.required, true);
  assert.equal(ready.t1441.totalGranteesOver5000, 1);
  assert.equal(ready.t1441.rows.length, 2, 'each individual grant to the >$5k aggregate grantee must be listed');
  assert.deepEqual(ready.t1441.rows.map(row => row.cashDisbursementsCad).sort(), ['3000.00','3500.00']);
  assert.ok(ready.t1441.rows.every(row => row.countriesOutsideCanada === 'US-United States'));
  assert.equal(ready.ledger.qualifiedDoneeTotalCad, '2500.00');
  assert.equal(ready.ledger.nonQualifiedDoneeTotalCad, '10500.00');
  assert.equal(ready.ledger.totalQualifyingDisbursementsCad, '13000.00');
  assert.match(ready.t1236.uploadCsv, /Grouped Qualified Donee/);
  assert.match(ready.t1441.uploadCsv, /Large International Grantee/);
  assert.match(ready.packageHash, /^[a-f0-9]{64}$/);

  const prepared = await prepareFiscalReportingPackage(repository, actor, {
    foundationOrgId: foundation.id,
    fiscalPeriodStart: '2026-01-01',
    fiscalPeriodEnd: '2026-12-31',
    idempotencyKey: 'fiscal-package-2026'
  });
  assert.equal(prepared.filing_ready, true);
  assert.equal(prepared.package_hash, ready.packageHash);
  const replay = await prepareFiscalReportingPackage(repository, actor, {
    foundationOrgId: foundation.id,
    fiscalPeriodStart: '2026-01-01',
    fiscalPeriodEnd: '2026-12-31',
    idempotencyKey: 'fiscal-package-2026'
  });
  assert.equal(replay.id, prepared.id);
  const loaded = await getFiscalReportingPackage(repository, actor, prepared.id);
  assert.equal(loaded.package_hash, ready.packageHash);
  assert.equal(loaded.payload.t3010.line5842NqdCountAtOrBelow5000, 1);

  console.log(JSON.stringify({
    ok: true,
    packageId: prepared.id,
    packageHash: prepared.package_hash,
    t3010: ready.t3010,
    t1236Rows: ready.t1236.rows.length,
    t1441Rows: ready.t1441.rows.length
  }, null, 2));
} finally {
  await pool.end();
}
