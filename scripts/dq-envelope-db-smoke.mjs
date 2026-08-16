import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { createAllocationPolicy } from '../src/automation/allocation_policies.mjs';
import { suggestDqAllocationEnvelope, createDqBackedAllocationPolicy, getDqPolicyBasis } from '../src/workflow/dq_envelopes.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, {
  auditHmacKey: process.env.AUDIT_HMAC_KEY || 'a'.repeat(40),
  encryptionKey: process.env.ENCRYPTION_KEY || 'e'.repeat(40)
});
const targetYear = new Date().getUTCFullYear();
const sourceYear = targetYear - 1;
const windowStart = `${targetYear}-01-01`;
const windowEnd = `${targetYear}-12-31`;

try {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const foundation = (await pool.query(`INSERT INTO organizations (business_number,legal_name,organization_type)
    VALUES ($1,$2,'foundation') RETURNING *`, [`987654321RR0001`, `DQ Envelope Foundation ${suffix}`])).rows[0];
  const recipient = (await pool.query(`INSERT INTO organizations (business_number,legal_name,organization_type)
    VALUES ($1,$2,'registered_charity') RETURNING *`, [`876543219RR0001`, `DQ Recipient ${suffix}`])).rows[0];
  let actor = await repository.upsertActorFromClaims({ subject: `dq-envelope-${suffix}`, email: `dq-${suffix.toLowerCase()}@example.ca`, displayName: 'DQ Analyst' });
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_analyst') ON CONFLICT DO NOTHING`, [actor.id, foundation.id]);
  actor = await repository.upsertActorFromClaims({ subject: `dq-envelope-${suffix}` });

  const fakeT3010 = {
    loaded: true,
    foundationProfile(bn) {
      if (bn !== foundation.business_number) return null;
      return {
        bn,
        name: foundation.legal_name,
        sourceYear,
        disbursementQuotaFields: {
          dq_805: '2000000', dq_815: '2000000', dq_840: '85000', dq_860: '90000', dq_865: '5000',
          dq_870: '2000000', dq_890: '85000'
        }
      };
    }
  };
  const service = { repository, t3010Repository: fakeT3010 };

  // Reserve CAD 20k in an existing enabled policy with no linked grants yet.
  await createAllocationPolicy(repository, actor, {
    foundationOrgId: foundation.id, title: `Existing reservation ${suffix}`, targetBudgetCad: 20000,
    minGrantCad: 5000, maxGrantCad: 10000, maxRecipients: 4, minimumScore: 0,
    purpose: 'Existing planned allocation', windowStart, windowEnd, refreshIntervalSeconds: 3600,
    autoMaterializeDrafts: true, idempotencyKey: `existing-policy-${suffix}`
  });

  // CAD 10k is attributed to this fiscal year's live grant pipeline.
  await pool.query(`INSERT INTO grants
    (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,planning_fiscal_year,creation_idempotency_key)
    VALUES ($1,$2,10000,'Attributed pipeline','qualified_donee','draft',$3,$4)`,
  [foundation.id, recipient.id, targetYear, `dq-attributed-${suffix}`]);

  // CAD 5k is active but not yet assigned a planning year; suggestions reserve it conservatively by default.
  await pool.query(`INSERT INTO grants
    (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,creation_idempotency_key)
    VALUES ($1,$2,5000,'Unattributed pipeline','qualified_donee','draft',$3)`,
  [foundation.id, recipient.id, `dq-unattributed-${suffix}`]);

  // CAD 5k was actually paid in the target window.
  const paid = (await pool.query(`INSERT INTO grants
    (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,planning_fiscal_year,creation_idempotency_key)
    VALUES ($1,$2,5000,'Executed grant','qualified_donee','paid',$3,$4) RETURNING id`,
  [foundation.id, recipient.id, targetYear, `dq-paid-${suffix}`])).rows[0];
  await pool.query(`INSERT INTO payment_intents
    (grant_id,provider,amount_cad,status,external_reference,recorded_at,idempotency_key)
    VALUES ($1,'manual',5000,'recorded',$2,now(),$3)`, [paid.id, `payment-${suffix}`, `dq-payment-${suffix}`]);

  const suggestionArgs = {
    foundationOrgId: foundation.id,
    targetFiscalYear: targetYear,
    windowStart,
    windowEnd,
    mode: 'auto',
    otherExpectedQualifyingDisbursementsCad: 10000,
    includeUnattributedPipeline: true
  };
  const suggestion = await suggestDqAllocationEnvelope(service, actor, suggestionArgs);
  assert.equal(suggestion.budgetBasis, 'dq_schedule8_next');
  assert.equal(suggestion.grossDqCad, 85000);
  assert.equal(suggestion.executedGrantCad, 5000);
  assert.equal(suggestion.activePipelineCad, 10000);
  assert.equal(suggestion.unattributedPipelineCad, 5000);
  assert.equal(suggestion.existingPolicyUnfilledCad, 20000);
  assert.equal(suggestion.otherExpectedQualifyingDisbursementsCad, 10000);
  assert.equal(suggestion.suggestedUnreservedEnvelopeCad, 35000);
  assert.match(suggestion.suggestionHash, /^[a-f0-9]{64}$/);

  const policy = await createDqBackedAllocationPolicy(service, actor, {
    ...suggestionArgs,
    suggestionHash: suggestion.suggestionHash,
    title: `DQ-backed ${targetYear} ${suffix}`,
    targetBudgetCad: 35000,
    focus: 'community food housing',
    minGrantCad: 5000,
    maxGrantCad: 15000,
    maxRecipients: 5,
    minimumScore: 0.1,
    purpose: 'General operating support',
    refreshIntervalSeconds: 3600,
    autoMaterializeDrafts: true,
    idempotencyKey: `dq-backed-policy-${suffix}`
  });
  assert.equal(policy.budgetBasis, 'dq_schedule8_next');
  assert.equal(policy.targetBudgetCad, 35000);
  const basis = await getDqPolicyBasis(service, actor, { policyId: policy.id });
  assert.equal(basis.budgetBasis, 'dq_schedule8_next');
  assert.equal(basis.budgetBasisHash, suggestion.suggestionHash);
  assert.equal(basis.budgetBasisSnapshot.suggestedUnreservedEnvelopeCad, 35000);

  // Policy-linked grants inherit the policy's fiscal year via the DB trigger.
  const linkedDraft = (await pool.query(`INSERT INTO grants
    (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,automation_policy_id,creation_idempotency_key)
    VALUES ($1,$2,5000,'Policy linked','qualified_donee','draft',$3,$4) RETURNING planning_fiscal_year`,
  [foundation.id, recipient.id, policy.id, `dq-linked-${suffix}`])).rows[0];
  assert.equal(linkedDraft.planning_fiscal_year, targetYear);

  // A changed reservation invalidates the reviewed hash before another DQ-backed policy can be created.
  await pool.query(`INSERT INTO grants
    (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,planning_fiscal_year,creation_idempotency_key)
    VALUES ($1,$2,1000,'Changed pipeline','qualified_donee','draft',$3,$4)`,
  [foundation.id, recipient.id, targetYear, `dq-changed-${suffix}`]);
  await assert.rejects(() => createDqBackedAllocationPolicy(service, actor, {
    ...suggestionArgs,
    suggestionHash: suggestion.suggestionHash,
    title: `Stale DQ policy ${suffix}`,
    minGrantCad: 5000, maxGrantCad: 15000, maxRecipients: 5,
    idempotencyKey: `dq-stale-${suffix}`
  }), /suggestion has changed/);

  console.log(JSON.stringify({ ok: true, targetYear, sourceYear, policyId: policy.id, suggestedEnvelopeCad: 35000, provenanceStored: true, staleHashBlocked: true }, null, 2));
} finally {
  await pool.end();
}
