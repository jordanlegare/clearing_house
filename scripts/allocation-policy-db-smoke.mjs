import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import {
  createAllocationPolicy,
  updateAllocationPolicy,
  runOneAllocationPolicy
} from '../src/automation/allocation_policies.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, {
  auditHmacKey: process.env.AUDIT_HMAC_KEY || 'a'.repeat(40),
  encryptionKey: process.env.ENCRYPTION_KEY || 'e'.repeat(40)
});

const profiles = [
  { bn: '111111111RR0001', name: 'North Food Centre', province: 'ON' },
  { bn: '222222222RR0001', name: 'Community Housing Network', province: 'ON' },
  { bn: '333333333RR0001', name: 'Neighbourhood Support Society', province: 'ON' },
  { bn: '444444444RR0001', name: 'Regional Food Access', province: 'ON' },
  { bn: '555555555RR0001', name: 'Family Resource Collective', province: 'ON' }
];
const profileMap = new Map(profiles.map(profile => [profile.bn, profile]));
const fakeT3010 = {
  loaded: true,
  matchFoundation() {
    return {
      confidence: 'fixture',
      evidenceTokens: ['food', 'housing', 'community'],
      matches: profiles.map((profile, index) => ({ ...profile, businessNumber: profile.bn, score: 1 - index * 0.1, matchedTerms: ['community'], rationale: 'CI fixture match' }))
    };
  },
  charityProfile(bn) { return profileMap.get(bn) || null; }
};

function date(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

try {
  const foundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type)
    VALUES ('999999999RR0001','Autonomous Test Foundation','foundation') RETURNING *
  `)).rows[0];
  let analyst = await repository.upsertActorFromClaims({ subject: 'allocation-policy-analyst', email: 'allocation@example.ca', displayName: 'Allocation Analyst' });
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_analyst') ON CONFLICT DO NOTHING`, [analyst.id, foundation.id]);
  analyst = await repository.upsertActorFromClaims({ subject: 'allocation-policy-analyst' });

  const policyInput = {
    foundationOrgId: foundation.id,
    title: 'Annual community allocation',
    targetBudgetCad: 100000,
    focus: 'food housing community',
    province: 'ON',
    minGrantCad: 25000,
    maxGrantCad: 50000,
    maxRecipients: 3,
    minimumScore: 0.1,
    purpose: 'General operating support',
    windowStart: date(-1),
    windowEnd: date(30),
    refreshIntervalSeconds: 300,
    autoMaterializeDrafts: true,
    idempotencyKey: 'policy-create-ci-0001'
  };
  const policy = await createAllocationPolicy(repository, analyst, policyInput);
  const replayed = await createAllocationPolicy(repository, analyst, policyInput);
  assert.equal(replayed.id, policy.id);

  const config = { automatedPortfoliosEnabled: true, allocationPolicyBatchSize: 10, paymentProvider: 'manual', notificationProvider: 'disabled', requireSeparationOfDuties: true, craStatusMaxAgeHours: 24 };
  const first = await runOneAllocationPolicy({ config, repository, policyId: policy.id, t3010Repository: fakeT3010 });
  assert.equal(first.draftCount, 3);
  assert.equal(first.plannedCad, 100000);

  let grants = (await pool.query(`SELECT g.id,g.state,g.amount_cad,o.business_number FROM grants g JOIN organizations o ON o.id=g.recipient_org_id WHERE g.automation_policy_id=$1 ORDER BY g.created_at`, [policy.id])).rows;
  assert.equal(grants.length, 3);
  assert.equal(grants.reduce((sum, row) => sum + Number(row.amount_cad), 0), 100000);
  assert.ok(grants.every(row => row.state === 'draft'));

  // A second run with the same active draft envelope must not create anything new.
  const second = await runOneAllocationPolicy({ config, repository, policyId: policy.id, t3010Repository: fakeT3010 });
  assert.equal(second.exhausted, true);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM grants WHERE automation_policy_id=$1', [policy.id])).rows[0].n), 3);

  // A declined recipient frees budget, but that same BN remains excluded from future automated selection.
  const declined = grants[0];
  await pool.query("UPDATE grants SET state='declined',updated_at=now() WHERE id=$1", [declined.id]);
  const refill = await runOneAllocationPolicy({ config, repository, policyId: policy.id, t3010Repository: fakeT3010 });
  assert.equal(refill.draftCount, 1);
  grants = (await pool.query(`SELECT g.id,g.state,g.amount_cad,o.business_number FROM grants g JOIN organizations o ON o.id=g.recipient_org_id WHERE g.automation_policy_id=$1 ORDER BY g.created_at`, [policy.id])).rows;
  assert.equal(grants.length, 4);
  const active = grants.filter(row => row.state !== 'declined');
  assert.equal(active.reduce((sum, row) => sum + Number(row.amount_cad), 0), 100000);
  assert.equal(active.some(row => row.business_number === declined.business_number), false);

  // Retried policy updates are exactly-once and do not repeatedly bump the version.
  const updated = await updateAllocationPolicy(repository, analyst, { policyId: policy.id, patch: { focus: 'food housing community families' }, idempotencyKey: 'policy-update-ci-0001' });
  const updatedReplay = await updateAllocationPolicy(repository, analyst, { policyId: policy.id, patch: { focus: 'food housing community families' }, idempotencyKey: 'policy-update-ci-0001' });
  assert.equal(updatedReplay.version, updated.version);
  assert.equal(updated.version, 2);

  const commands = Number((await pool.query('SELECT count(*) AS n FROM foundation_allocation_policy_commands WHERE policy_id=$1', [policy.id])).rows[0].n);
  const runs = Number((await pool.query('SELECT count(*) AS n FROM foundation_allocation_policy_runs WHERE policy_id=$1', [policy.id])).rows[0].n);
  assert.ok(commands >= 2);
  assert.ok(runs >= 3);
  console.log(JSON.stringify({ ok: true, policyId: policy.id, activeCad: 100000, recipientsReplacedAfterDecline: true, idempotentCommands: true, runs }, null, 2));
} finally {
  await pool.end();
}
