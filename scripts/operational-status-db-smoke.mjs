import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { buildOperationalStatus } from '../src/ops/status.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(databaseUrl);

try {
  const user = (await pool.query(`INSERT INTO users (oidc_subject,email,display_name) VALUES ('ops-smoke-user','ops@example.test','Ops Smoke') RETURNING id`)).rows[0];
  const foundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province)
    VALUES ('111111111RR0001','Visible Foundation','foundation','ON') RETURNING id
  `)).rows[0];
  const hiddenFoundation = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province)
    VALUES ('222222222RR0001','Hidden Foundation','foundation','QC') RETURNING id
  `)).rows[0];
  const recipient = (await pool.query(`
    INSERT INTO organizations (business_number,legal_name,organization_type,province)
    VALUES ('333333333RR0001','Recipient Charity','registered_charity','ON') RETURNING id
  `)).rows[0];
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_analyst')`, [user.id, foundation.id]);
  await pool.query(`
    INSERT INTO automation_jobs (name,enabled,interval_seconds,next_run_at,last_status,last_completed_at)
    VALUES ('ops-smoke',true,3600,now()+interval '1 hour','success',now())
    ON CONFLICT (name) DO UPDATE SET enabled=true,next_run_at=EXCLUDED.next_run_at,last_status='success',last_completed_at=now()
  `);
  await pool.query(`
    INSERT INTO automation_worker_heartbeats (worker_id,state,heartbeat_at)
    VALUES ('ops-smoke-worker','idle',now())
    ON CONFLICT (worker_id) DO UPDATE SET state='idle',heartbeat_at=now()
  `);
  const grant = (await pool.query(`
    INSERT INTO grants (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state)
    VALUES ($1,$2,25000,'General operating support','qualified_donee','accepted') RETURNING id
  `, [foundation.id, recipient.id])).rows[0];
  await pool.query(`
    INSERT INTO recipient_contact_discovery
      (organization_id,website_url,status,attempts,pages_visited,candidates_found,inserted_contacts,last_attempt_at,next_attempt_at)
    VALUES ($1,'https://recipient.example','no_candidates',1,2,0,0,now(),now()+interval '7 days')
  `, [recipient.id]);

  const actor = {
    id: user.id,
    subject: 'ops-smoke-user',
    roles: [],
    memberships: [{ organizationId: foundation.id, role: 'foundation_analyst' }]
  };
  const t3010Repository = { status: () => ({ loaded: true, year: 2024, charities: 1, foundations: 1, dqRecords: 1 }) };

  const first = await buildOperationalStatus({ repository: { pool }, t3010Repository, actor });
  assert.equal(first.foundations.length, 1);
  assert.equal(first.foundations[0].foundation.id, foundation.id);
  assert.equal(first.foundations[0].grants.byState.accepted, 1);
  assert.equal(first.foundations[0].grants.activeCad, 25000);
  assert.equal(first.foundations[0].websiteDiscovery.no_candidates, 1);
  assert.equal(first.foundations[0].compliance.acceptedPendingCompliance, 1);
  assert.equal(first.system.activeWorkers.length >= 1, true);
  assert.equal(first.attention.some(item => item.code === 'compliance_waiting'), true);
  assert.equal(first.foundations.some(item => item.foundation.id === hiddenFoundation.id), false);

  await assert.rejects(
    buildOperationalStatus({ repository: { pool }, t3010Repository, actor, organizationId: hiddenFoundation.id }),
    /permission|accessible foundation/i
  );

  await pool.query(`
    INSERT INTO compliance_reviews (grant_id,reviewer_user_id,decision,rationale,idempotency_key)
    VALUES ($1,$2,'approved','Smoke compliance approved','ops-smoke-compliance')
  `, [grant.id, user.id]);
  await pool.query(`
    INSERT INTO recipient_status_checks
      (organization_id,source,source_record_id,status,evidence,verified_at,expires_at,assurance_level,observed_status,checked_by,idempotency_key)
    VALUES ($1,'cra_list_of_charities','333333333RR0001','eligible','{}'::jsonb,now(),now()+interval '24 hours','authoritative','registered',$2,'ops-smoke-status')
  `, [recipient.id, user.id]);
  const second = await buildOperationalStatus({ repository: { pool }, t3010Repository, actor, organizationId: foundation.id });
  assert.equal(second.foundations[0].compliance.acceptedPendingCompliance, 0);
  assert.equal(second.foundations[0].compliance.approvedCompliancePendingFreshStatus, 0);

  console.log(JSON.stringify({
    ok: true,
    foundationId: foundation.id,
    attentionBefore: first.attention.map(item => item.code),
    attentionAfter: second.attention.map(item => item.code)
  }, null, 2));
} finally {
  await pool.end();
}
