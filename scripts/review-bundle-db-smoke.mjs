import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { WorkflowService } from '../src/workflow/workflow_service.mjs';
import { createAllocationPolicy } from '../src/automation/allocation_policies.mjs';
import { runReviewBundlesJob } from '../src/automation/review_bundle_worker.mjs';
import {
  approveReviewBundle,
  getReviewBundle,
  setPolicyExecutionOptions
} from '../src/workflow/review_bundles.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, {
  auditHmacKey: process.env.AUDIT_HMAC_KEY || 'a'.repeat(40),
  encryptionKey: process.env.ENCRYPTION_KEY || 'e'.repeat(40)
});
const config = {
  automatedPortfoliosEnabled: true,
  allocationPolicyBatchSize: 20,
  paymentProvider: 'manual',
  notificationProvider: 'disabled',
  requireSeparationOfDuties: true,
  craStatusMaxAgeHours: 24
};

function date(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

try {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 9).toUpperCase();
  const foundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type)
    VALUES ($1,$2,'foundation') RETURNING *
  `, [`9${suffix}RR0001`.slice(0, 15), `Bundle Foundation ${suffix}`])).rows[0];

  let analyst = await repository.upsertActorFromClaims({ subject: `bundle-analyst-${suffix}`, email: `analyst-${suffix}@example.ca`, displayName: 'Bundle Analyst' });
  let approver = await repository.upsertActorFromClaims({ subject: `bundle-approver-${suffix}`, email: `approver-${suffix}@example.ca`, displayName: 'Bundle Approver' });
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_analyst') ON CONFLICT DO NOTHING`, [analyst.id, foundation.id]);
  // Give the analyst approval permission too so the self-approval assertion exercises
  // the separation-of-duties rule itself rather than failing earlier on RBAC.
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_approver') ON CONFLICT DO NOTHING`, [analyst.id, foundation.id]);
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_approver') ON CONFLICT DO NOTHING`, [approver.id, foundation.id]);
  analyst = await repository.upsertActorFromClaims({ subject: `bundle-analyst-${suffix}` });
  approver = await repository.upsertActorFromClaims({ subject: `bundle-approver-${suffix}` });

  const policy = await createAllocationPolicy(repository, analyst, {
    foundationOrgId: foundation.id,
    title: `Auto-proposal policy ${suffix}`,
    targetBudgetCad: 90000,
    minGrantCad: 10000,
    maxGrantCad: 40000,
    maxRecipients: 6,
    minimumScore: 0,
    purpose: 'General operating support',
    windowStart: date(-1),
    windowEnd: date(60),
    refreshIntervalSeconds: 3600,
    autoMaterializeDrafts: true,
    idempotencyKey: `bundle-policy-create-${suffix}`
  });

  const options = await setPolicyExecutionOptions(repository, analyst, {
    policyId: policy.id,
    autoProposeDrafts: true,
    idempotencyKey: `bundle-options-${suffix}`
  });
  assert.equal(options.autoProposeDrafts, true);
  const replayOptions = await setPolicyExecutionOptions(repository, analyst, {
    policyId: policy.id,
    autoProposeDrafts: true,
    idempotencyKey: `bundle-options-${suffix}`
  });
  assert.equal(replayOptions.autoProposeDrafts, true);

  const grantIds = [];
  for (let i = 0; i < 3; i += 1) {
    const bn = `${i + 1}${suffix}RR0001`.slice(0, 15);
    const recipient = (await pool.query(`
      INSERT INTO organizations (business_number,legal_name,organization_type)
      VALUES ($1,$2,'registered_charity') RETURNING *
    `, [bn, `Bundle Recipient ${i + 1} ${suffix}`])).rows[0];
    const grant = (await pool.query(`
      INSERT INTO grants
        (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,automation_policy_id,creation_idempotency_key)
      VALUES ($1,$2,$3,'General operating support','qualified_donee','draft',$4,$5)
      RETURNING id
    `, [foundation.id, recipient.id, 20000 + i * 5000, policy.id, `bundle-draft-${suffix}-${i}`])).rows[0];
    grantIds.push(grant.id);
  }

  const workerResult = await runReviewBundlesJob({ config, repository });
  const policyResult = workerResult.results.find(row => row.policyId === policy.id);
  assert.equal(policyResult?.status, 'success');
  assert.ok(policyResult?.bundleId);

  let bundle = await getReviewBundle(repository, analyst, { bundleId: policyResult.bundleId });
  assert.equal(bundle.status, 'open');
  assert.equal(bundle.grantCount, 3);
  assert.equal(bundle.totalCad, 75000);
  assert.equal(bundle.createdBy, analyst.id);
  assert.ok(bundle.items.every(item => item.state === 'proposed'));
  assert.ok(bundle.items.every(item => item.proposedBy === analyst.id));

  await assert.rejects(() => approveReviewBundle(new WorkflowService({ repository, t3010Repository: null, config }), approver, {
    bundleId: bundle.id,
    bundleHash: '0'.repeat(64),
    idempotencyKey: `bundle-bad-hash-${suffix}`
  }), /hash does not match/);

  await assert.rejects(() => approveReviewBundle(new WorkflowService({ repository, t3010Repository: null, config }), analyst, {
    bundleId: bundle.id,
    bundleHash: bundle.bundleHash,
    idempotencyKey: `bundle-self-approve-${suffix}`
  }), /Separation of duties/);

  const service = new WorkflowService({ repository, t3010Repository: null, config });
  bundle = await approveReviewBundle(service, approver, {
    bundleId: bundle.id,
    bundleHash: bundle.bundleHash,
    idempotencyKey: `bundle-approve-${suffix}`
  });
  assert.equal(bundle.status, 'approved');
  assert.equal(bundle.approvedBy, approver.id);
  assert.ok(bundle.items.every(item => item.state === 'approved'));

  const replay = await approveReviewBundle(service, approver, {
    bundleId: bundle.id,
    bundleHash: bundle.bundleHash,
    idempotencyKey: `bundle-approve-${suffix}`
  });
  assert.equal(replay.status, 'approved');
  const approvalEvents = Number((await pool.query(`
    SELECT count(*) AS n FROM grant_events
    WHERE grant_id=ANY($1::uuid[]) AND to_state='approved'
  `, [grantIds])).rows[0].n);
  assert.equal(approvalEvents, 3);

  // Crash-recovery shape: a later unbundled draft is proposed and bundled even though
  // allocation generation itself does not need to run again.
  const recoveryRecipient = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type)
    VALUES ($1,$2,'registered_charity') RETURNING *
  `, [`8${suffix}RR0001`.slice(0, 15), `Recovered Recipient ${suffix}`])).rows[0];
  const recoveryGrant = (await pool.query(`
    INSERT INTO grants
      (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,automation_policy_id,creation_idempotency_key)
    VALUES ($1,$2,15000,'General operating support','qualified_donee','draft',$3,$4)
    RETURNING id
  `, [foundation.id, recoveryRecipient.id, policy.id, `bundle-recovery-${suffix}`])).rows[0];
  const recoveryRun = await runReviewBundlesJob({ config, repository });
  const recoveryPolicyResult = recoveryRun.results.find(row => row.policyId === policy.id);
  assert.ok(recoveryPolicyResult?.bundleId);
  const recoveryBundle = await getReviewBundle(repository, approver, { bundleId: recoveryPolicyResult.bundleId });
  assert.equal(recoveryBundle.grantCount, 1);
  assert.equal(recoveryBundle.items[0].grantId, recoveryGrant.id);
  assert.equal(recoveryBundle.items[0].state, 'proposed');

  const auditCount = Number((await pool.query(`
    SELECT count(*) AS n FROM audit_log
    WHERE resource_type='grant_review_bundle' AND resource_id=$1
  `, [bundle.id])).rows[0].n);
  assert.ok(auditCount >= 2);

  console.log(JSON.stringify({
    ok: true,
    policyId: policy.id,
    approvedBundleId: bundle.id,
    approvedGrantCount: 3,
    oneActionApproval: true,
    selfApprovalBlocked: true,
    retryIdempotent: true,
    recoveryBundleId: recoveryBundle.id
  }, null, 2));
} finally {
  await pool.end();
}
