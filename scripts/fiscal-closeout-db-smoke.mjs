import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import {
  prepareFiscalReportingPackage,
  setGrantReportingMetadata
} from '../src/compliance/fiscal_package.mjs';
import {
  getFiscalReportingSubmission,
  recordFiscalReportingSubmission
} from '../src/compliance/fiscal_closeout.mjs';

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.ENCRYPTION_KEY;
const auditHmacKey = process.env.AUDIT_HMAC_KEY;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { encryptionKey, auditHmacKey });

async function paidGrant({ foundationId, recipientId, recipientType, amountCad, purpose, recordedAt, suffix }) {
  const grant = (await pool.query(`
    INSERT INTO grants (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,creation_idempotency_key)
    VALUES ($1,$2,$3,$4,$5,'paid',$6) RETURNING id
  `, [foundationId, recipientId, amountCad, purpose, recipientType, `closeout-grant-${suffix}`])).rows[0];
  await pool.query(`
    INSERT INTO payment_intents (grant_id,provider,amount_cad,status,external_reference,recorded_at)
    VALUES ($1,'manual',$2,'recorded',$3,$4)
  `, [grant.id, amountCad, `closeout-payment-${suffix}`, recordedAt]);
  return grant.id;
}

try {
  const user = (await pool.query(`
    INSERT INTO users (oidc_subject,email,display_name)
    VALUES ('fiscal-closeout-user','closeout@example.test','Fiscal Closeout User') RETURNING id
  `)).rows[0];
  const foundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province,public_profile)
    VALUES ('314159265RR0001','Closeout Foundation','foundation','ON','{}'::jsonb) RETURNING id
  `)).rows[0];
  const qd = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province,public_profile)
    VALUES ('271828182RR0001','Closeout Qualified Donee','registered_charity','ON',$1::jsonb) RETURNING id
  `, [JSON.stringify({ city: 'Kingston', country: 'Canada' })])).rows[0];
  const nqd = (await pool.query(`
    INSERT INTO organizations (legal_name,organization_type,province,public_profile)
    VALUES ('Closeout Non-qualified Donee','non_qualified_donee','ON',$1::jsonb) RETURNING id
  `, [JSON.stringify({ city: 'Hamilton', country: 'Canada' })])).rows[0];
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_approver')`, [user.id, foundation.id]);
  const actor = {
    id: user.id,
    subject: 'fiscal-closeout-user',
    roles: [],
    memberships: [{ organizationId: foundation.id, role: 'foundation_approver' }]
  };

  const qdGrant = await paidGrant({
    foundationId: foundation.id,
    recipientId: qd.id,
    recipientType: 'qualified_donee',
    amountCad: '2400.00',
    purpose: 'Core operations',
    recordedAt: '2026-02-20T12:00:00Z',
    suffix: 'qd'
  });
  const nqdGrant = await paidGrant({
    foundationId: foundation.id,
    recipientId: nqd.id,
    recipientType: 'non_qualified_donee',
    amountCad: '6200.00',
    purpose: 'Community food services',
    recordedAt: '2026-07-15T12:00:00Z',
    suffix: 'nqd'
  });
  const outsidePeriodGrant = await paidGrant({
    foundationId: foundation.id,
    recipientId: qd.id,
    recipientType: 'qualified_donee',
    amountCad: '1800.00',
    purpose: 'Prior-period operations',
    recordedAt: '2025-12-31T12:00:00Z',
    suffix: 'outside'
  });

  await setGrantReportingMetadata(repository, actor, {
    grantId: qdGrant,
    associatedCharity: false,
    idempotencyKey: 'closeout-meta-qd'
  });
  await setGrantReportingMetadata(repository, actor, {
    grantId: nqdGrant,
    activitiesOutsideCanada: false,
    idempotencyKey: 'closeout-meta-nqd'
  });

  const fiscalPackage = await prepareFiscalReportingPackage(repository, actor, {
    foundationOrgId: foundation.id,
    fiscalPeriodStart: '2026-01-01',
    fiscalPeriodEnd: '2026-12-31',
    idempotencyKey: 'closeout-package-2026'
  });
  assert.equal(fiscalPackage.filing_ready, true);

  await assert.rejects(
    recordFiscalReportingSubmission(repository, actor, {
      packageId: fiscalPackage.id,
      externalSubmissionReference: '',
      idempotencyKey: 'closeout-missing-reference'
    }),
    /external.*submission reference is required/i
  );

  const submission = await recordFiscalReportingSubmission(repository, actor, {
    packageId: fiscalPackage.id,
    externalSubmissionReference: 'CRA-EFILE-CONFIRMATION-2026-001',
    submittedAt: '2027-03-15T14:30:00Z',
    idempotencyKey: 'closeout-submit-2026'
  });
  assert.equal(submission.packageId, fiscalPackage.id);
  assert.equal(submission.packageHash, fiscalPackage.package_hash);
  assert.equal(submission.externalSubmissionReference, 'CRA-EFILE-CONFIRMATION-2026-001');
  assert.equal(submission.grantCount, 2);
  assert.deepEqual(new Set(submission.reportedGrantIds), new Set([qdGrant, nqdGrant]));

  const states = await pool.query('SELECT id,state FROM grants WHERE id=ANY($1::uuid[])', [[qdGrant,nqdGrant,outsidePeriodGrant]]);
  const stateById = Object.fromEntries(states.rows.map(row => [row.id, row.state]));
  assert.equal(stateById[qdGrant], 'reported');
  assert.equal(stateById[nqdGrant], 'reported');
  assert.equal(stateById[outsidePeriodGrant], 'paid', 'a payment outside the frozen fiscal period must not be closed out');

  const records = await pool.query(`
    SELECT grant_id,status,payload FROM reporting_records
    WHERE grant_id=ANY($1::uuid[]) AND fiscal_year=2026 ORDER BY grant_id
  `, [[qdGrant,nqdGrant]]);
  assert.equal(records.rows.length, 2);
  for (const record of records.rows) {
    assert.equal(record.status, 'filed');
    assert.equal(record.payload.submissionReference, 'CRA-EFILE-CONFIRMATION-2026-001');
    assert.equal(record.payload.fiscalReportingPackageId, fiscalPackage.id);
    assert.equal(record.payload.fiscalReportingPackageHash, fiscalPackage.package_hash);
    assert.equal(record.payload.filingStatus, 'external_submission_reference_recorded');
  }

  const events = await pool.query(`
    SELECT grant_id,from_state,to_state,metadata FROM grant_events
    WHERE grant_id=ANY($1::uuid[]) AND to_state='reported'
  `, [[qdGrant,nqdGrant]]);
  assert.equal(events.rows.length, 2);
  assert.ok(events.rows.every(row => row.from_state === 'paid'));
  assert.ok(events.rows.every(row => row.metadata.submissionReference === 'CRA-EFILE-CONFIRMATION-2026-001'));

  const replay = await recordFiscalReportingSubmission(repository, actor, {
    packageId: fiscalPackage.id,
    externalSubmissionReference: 'CRA-EFILE-CONFIRMATION-2026-001',
    submittedAt: '2027-03-15T14:30:00Z',
    idempotencyKey: 'closeout-submit-2026'
  });
  assert.equal(replay.id, submission.id);
  assert.equal(replay.grantCount, 2);

  await assert.rejects(
    recordFiscalReportingSubmission(repository, actor, {
      packageId: fiscalPackage.id,
      externalSubmissionReference: 'DIFFERENT-CRA-REFERENCE',
      submittedAt: '2027-03-15T14:30:00Z',
      idempotencyKey: 'closeout-conflicting-reference'
    }),
    /already closed out|different external submission reference/i
  );

  const loaded = await getFiscalReportingSubmission(repository, actor, fiscalPackage.id);
  assert.equal(loaded.id, submission.id);
  assert.equal(loaded.externalSubmissionReference, 'CRA-EFILE-CONFIRMATION-2026-001');

  console.log(JSON.stringify({
    ok: true,
    packageId: fiscalPackage.id,
    submissionId: submission.id,
    packageHash: submission.packageHash,
    grantCount: submission.grantCount,
    outsidePeriodState: stateById[outsidePeriodGrant]
  }, null, 2));
} finally {
  await pool.end();
}
