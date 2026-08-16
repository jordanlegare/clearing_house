import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { AutomationScheduler } from '../src/automation/scheduler.mjs';
import { maintenanceJob } from '../src/automation/jobs.mjs';
import { checkDatabaseSchema } from '../src/db/schema_readiness.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(databaseUrl);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const schema = await checkDatabaseSchema(pool);
  assert.equal(schema.ready, true, JSON.stringify(schema));

  await pool.query(`
    INSERT INTO automation_jobs (name,enabled,interval_seconds,next_run_at,last_status)
    VALUES ('resilience-race',true,3600,now()-interval '1 second',NULL)
    ON CONFLICT (name) DO UPDATE SET enabled=true,interval_seconds=3600,next_run_at=now()-interval '1 second',
      locked_by=NULL,locked_until=NULL,last_status=NULL,last_error=NULL
  `);

  const workerA = new AutomationScheduler(pool, { leaseSeconds: 3 });
  const workerB = new AutomationScheduler(pool, { leaseSeconds: 3 });
  const [claimsA, claimsB] = await Promise.all([
    workerA.claimDueJobs('worker-a', 1),
    workerB.claimDueJobs('worker-b', 1)
  ]);
  assert.equal(claimsA.length + claimsB.length, 1, 'exactly one worker must claim a due job');
  const winnerId = claimsA.length ? 'worker-a' : 'worker-b';
  const loserId = winnerId === 'worker-a' ? 'worker-b' : 'worker-a';
  const winner = winnerId === 'worker-a' ? workerA : workerB;
  const loser = winnerId === 'worker-a' ? workerB : workerA;
  const initial = (claimsA[0] || claimsB[0]);
  const initialExpiry = new Date(initial.locked_until).getTime();

  assert.equal(await loser.renewLease('resilience-race', loserId), null, 'non-owner must not renew a lease');
  await sleep(75);
  const renewed = await winner.renewLease('resilience-race', winnerId);
  assert.ok(renewed, 'owner should renew an active lease');
  assert.ok(new Date(renewed.locked_until).getTime() > initialExpiry, 'renewal should extend lease expiry');

  await pool.query(`UPDATE automation_jobs SET locked_until=now()-interval '1 second' WHERE name='resilience-race'`);
  const reclaimed = await loser.claimDueJobs(loserId, 1);
  assert.equal(reclaimed.length, 1, 'expired lease should be recoverable by another worker');
  await assert.rejects(
    winner.complete('resilience-race', winnerId, { stale: true }),
    /expired, lost, or no longer owned/i,
    'stale worker must not complete after lease loss'
  );
  assert.ok(await loser.renewLease('resilience-race', loserId));
  const completed = await loser.complete('resilience-race', loserId, { recovered: true });
  assert.equal(completed.last_status, 'success');

  const notification = (await pool.query(`
    INSERT INTO notification_outbox (grant_id,channel,recipient,template,payload,status,idempotency_key,locked_at,lock_token,attempts)
    VALUES (NULL,'sms','encrypted-placeholder','contact_verification','{}'::jsonb,'queued','resilience-stale-notification',now()-interval '30 minutes','dead-worker',1)
    ON CONFLICT (idempotency_key) DO UPDATE SET status='queued',locked_at=now()-interval '30 minutes',lock_token='dead-worker'
    RETURNING id
  `)).rows[0];
  const maintenance = await maintenanceJob({ pool });
  assert.ok(maintenance.recoveredNotificationLocks >= 1);
  const recoveredNotification = (await pool.query('SELECT locked_at,lock_token FROM notification_outbox WHERE id=$1', [notification.id])).rows[0];
  assert.equal(recoveredNotification.locked_at, null);
  assert.equal(recoveredNotification.lock_token, null);

  console.log(JSON.stringify({
    ok: true,
    winnerId,
    recoveredBy: loserId,
    schemaObjects: schema.expectedObjects,
    recoveredNotificationLocks: maintenance.recoveredNotificationLocks
  }, null, 2));
} finally {
  await pool.end();
}
