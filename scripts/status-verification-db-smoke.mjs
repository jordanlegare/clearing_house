import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { WorkflowService } from '../src/workflow/workflow_service.mjs';
import {
  confirmStatusVerificationTask,
  listStatusVerificationTasks,
  refreshStatusVerificationTasks
} from '../src/workflow/status_verification_tasks.mjs';

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.ENCRYPTION_KEY;
const auditHmacKey = process.env.AUDIT_HMAC_KEY;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
if (!encryptionKey || encryptionKey.length < 32) throw new Error('ENCRYPTION_KEY is required.');
if (!auditHmacKey || auditHmacKey.length < 32) throw new Error('AUDIT_HMAC_KEY is required.');

const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { encryptionKey, auditHmacKey });
const config = {
  enableWorkflowWrites: true,
  craStatusMaxAgeHours: 24,
  paymentProvider: 'manual',
  requireSeparationOfDuties: true
};
const service = new WorkflowService({ repository, t3010Repository: null, config });

async function createAcceptedCompliantGrant({ foundationId, recipientId, reviewerId, amountCad, suffix }) {
  const grant = (await pool.query(`
    INSERT INTO grants (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,creation_idempotency_key)
    VALUES ($1,$2,$3,'General operating support','qualified_donee','accepted',$4)
    RETURNING id
  `, [foundationId, recipientId, amountCad, `status-smoke-grant-${suffix}`])).rows[0];
  await pool.query(`
    INSERT INTO compliance_reviews (grant_id,reviewer_user_id,decision,rationale,idempotency_key)
    VALUES ($1,$2,'approved','Approved for status-verification smoke',$3)
  `, [grant.id, reviewerId, `status-smoke-compliance-${suffix}`]);
  return grant.id;
}

try {
  const reviewer = (await pool.query(`
    INSERT INTO users (oidc_subject,email,display_name)
    VALUES ('status-reviewer','status-reviewer@example.test','Status Reviewer') RETURNING id
  `)).rows[0];
  const outsider = (await pool.query(`
    INSERT INTO users (oidc_subject,email,display_name)
    VALUES ('status-outsider','status-outsider@example.test','Status Outsider') RETURNING id
  `)).rows[0];
  const foundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province)
    VALUES ('444444444RR0001','Status Evidence Foundation','foundation','ON') RETURNING id
  `)).rows[0];
  const otherFoundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province)
    VALUES ('555555555RR0001','Other Foundation','foundation','QC') RETURNING id
  `)).rows[0];
  const recipientA = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province)
    VALUES ('666666666RR0001','Manual Confirmation Charity','registered_charity','ON') RETURNING id
  `)).rows[0];
  const recipientB = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province)
    VALUES ('777777777RR0001','Revocation Evidence Charity','registered_charity','BC') RETURNING id
  `)).rows[0];

  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'compliance_reviewer')`, [reviewer.id, foundation.id]);
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'compliance_reviewer')`, [outsider.id, otherFoundation.id]);

  const grantA = await createAcceptedCompliantGrant({
    foundationId: foundation.id,
    recipientId: recipientA.id,
    reviewerId: reviewer.id,
    amountCad: 12500,
    suffix: 'a'
  });

  let fetchCount = 0;
  const noRevocationFetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200, text: async () => '<html><body>Published revocations without the test BN.</body></html>' };
  };
  const firstRefresh = await refreshStatusVerificationTasks({ config, repository, fetchImpl: noRevocationFetch });
  assert.equal(firstRefresh.processed, 1);
  assert.equal(firstRefresh.manualConfirmationRequired, 1);
  assert.equal(firstRefresh.revocationEvidenceFound, 0);
  assert.equal(fetchCount, 1, 'one public-source fetch should cover the whole refresh batch');

  const reviewerActor = {
    id: reviewer.id,
    subject: 'status-reviewer',
    roles: [],
    memberships: [{ organizationId: foundation.id, role: 'compliance_reviewer' }]
  };
  const outsiderActor = {
    id: outsider.id,
    subject: 'status-outsider',
    roles: [],
    memberships: [{ organizationId: otherFoundation.id, role: 'compliance_reviewer' }]
  };
  const tasksA = await listStatusVerificationTasks(repository, reviewerActor, { foundationOrgId: foundation.id });
  assert.equal(tasksA.length, 1);
  assert.equal(tasksA[0].grantId, grantA);
  assert.equal(tasksA[0].status, 'manual_confirmation_required');
  assert.equal(tasksA[0].publicEvidence.revocationEvidenceFound, false);
  assert.equal(tasksA[0].publicEvidence.status, 'not_determined');
  assert.match(tasksA[0].publicEvidence.warning, /not proof|confirm current status/i);
  await assert.rejects(
    listStatusVerificationTasks(repository, outsiderActor, { foundationOrgId: foundation.id }),
    /lacks permission/i
  );

  const completedA = await confirmStatusVerificationTask(service, reviewerActor, {
    taskId: tasksA[0].id,
    observedStatus: 'registered',
    idempotencyKey: 'status-smoke-confirm-a'
  });
  assert.equal(completedA.status, 'completed');
  const latestA = (await pool.query(`
    SELECT status,assurance_level,observed_status,source,evidence
    FROM recipient_status_checks WHERE organization_id=$1 ORDER BY verified_at DESC LIMIT 1
  `, [recipientA.id])).rows[0];
  assert.equal(latestA.status, 'eligible');
  assert.equal(latestA.assurance_level, 'authoritative');
  assert.equal(latestA.observed_status, 'registered');
  assert.equal(latestA.source, 'cra_list_of_charities');
  assert.equal(latestA.evidence.statusVerificationTaskId, tasksA[0].id);

  const grantB = await createAcceptedCompliantGrant({
    foundationId: foundation.id,
    recipientId: recipientB.id,
    reviewerId: reviewer.id,
    amountCad: 17500,
    suffix: 'b'
  });
  let revocationFetchCount = 0;
  const revocationFetch = async () => {
    revocationFetchCount += 1;
    return { ok: true, status: 200, text: async () => '<html><body>Revoked organization: 777777777RR0001</body></html>' };
  };
  const secondRefresh = await refreshStatusVerificationTasks({ config, repository, fetchImpl: revocationFetch });
  assert.equal(secondRefresh.processed, 1, 'fresh authoritative status should keep the first grant out of the queue');
  assert.equal(secondRefresh.revocationEvidenceFound, 1);
  assert.equal(revocationFetchCount, 1);
  const tasksB = await listStatusVerificationTasks(repository, reviewerActor, { status: 'revocation_evidence_found' });
  assert.equal(tasksB.length, 1);
  assert.equal(tasksB[0].grantId, grantB);
  assert.equal(tasksB[0].publicEvidence.revocationEvidenceFound, true);
  await assert.rejects(
    confirmStatusVerificationTask(service, reviewerActor, {
      taskId: tasksB[0].id,
      observedStatus: 'registered',
      idempotencyKey: 'status-smoke-conflict-b'
    }),
    /revocation evidence conflicts/i
  );
  const completedB = await confirmStatusVerificationTask(service, reviewerActor, {
    taskId: tasksB[0].id,
    observedStatus: 'revoked',
    idempotencyKey: 'status-smoke-confirm-b'
  });
  assert.equal(completedB.status, 'completed');
  const latestB = (await pool.query(`
    SELECT status,assurance_level,observed_status
    FROM recipient_status_checks WHERE organization_id=$1 ORDER BY verified_at DESC LIMIT 1
  `, [recipientB.id])).rows[0];
  assert.equal(latestB.status, 'ineligible');
  assert.equal(latestB.assurance_level, 'authoritative');
  assert.equal(latestB.observed_status, 'revoked');

  console.log(JSON.stringify({
    ok: true,
    firstGrant: grantA,
    secondGrant: grantB,
    manualConfirmationRequired: firstRefresh.manualConfirmationRequired,
    revocationEvidenceFound: secondRefresh.revocationEvidenceFound
  }, null, 2));
} finally {
  await pool.end();
}
