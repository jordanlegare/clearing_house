import crypto from 'node:crypto';
import path from 'node:path';
import { createDatabasePool } from '../src/db/pool.mjs';
import { assertDatabaseSchema } from '../src/db/schema_readiness.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';
import { createNotificationProvider } from '../src/integrations/notification.mjs';
import { DEFAULT_T3010_YEAR } from '../src/t3010/constants.mjs';
import { AutomationScheduler, jobDefinitions } from '../src/automation/scheduler.mjs';
import { runAutomationJob } from '../src/automation/jobs.mjs';

const config = loadRuntimeConfig();
const readiness = assessReadiness(config);
const runOnce = process.argv.includes('--once');
const workerId = process.env.AUTOMATION_WORKER_ID || `worker-${crypto.randomUUID()}`;
const year = Number(process.env.T3010_YEAR || DEFAULT_T3010_YEAR);
const dataDir = path.resolve(process.env.T3010_DATA_DIR || path.join('data', 't3010', String(year)));

if (!config.automationEnabled) {
  console.log(JSON.stringify({ workerId, enabled: false, message: 'AUTOMATION_ENABLED is off.' }));
  process.exit(0);
}
if (!readiness.ready) {
  console.error(JSON.stringify(readiness, null, 2));
  process.exit(2);
}
if (!config.databaseUrl) throw new Error('DATABASE_URL is required when autonomous operations are enabled.');

const pool = createDatabasePool(config.databaseUrl);
await assertDatabaseSchema(pool);
const scheduler = new AutomationScheduler(pool, { leaseSeconds: config.automationLeaseSeconds });
const repository = new WorkflowRepository(pool, { auditHmacKey: config.auditHmacKey, encryptionKey: config.encryptionKey });
const provider = config.notificationProvider === 'disabled' ? null : createNotificationProvider(config);
let stopping = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runWithLeaseRenewal(job, work) {
  const renewEveryMs = Math.max(1000, Math.min(Math.floor(config.automationLeaseSeconds * 1000 / 3), 60_000));
  let stopped = false;
  let renewing = false;
  let leaseLost = false;
  let renewalError = null;

  const renew = async () => {
    if (stopped || renewing || leaseLost) return;
    renewing = true;
    try {
      const lease = await scheduler.renewLease(job.name, workerId);
      if (!lease) {
        leaseLost = true;
        return;
      }
      await scheduler.heartbeat(workerId, `running:${job.name}`, {
        leaseRenewedAt: new Date().toISOString(),
        leaseUntil: lease.locked_until?.toISOString?.() || lease.locked_until
      });
    } catch (error) {
      renewalError = error;
    } finally {
      renewing = false;
    }
  };

  const timer = setInterval(() => { void renew(); }, renewEveryMs);
  timer.unref?.();
  try {
    const result = await work();
    if (renewing) while (renewing) await sleep(10);
    if (leaseLost) throw new Error(`Automation lease for ${job.name} was lost while work was running.`);
    if (renewalError) {
      const finalRenewal = await scheduler.renewLease(job.name, workerId);
      if (!finalRenewal) throw new Error(`Automation lease for ${job.name} could not be renewed after a renewal error: ${renewalError.message}`);
    }
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

async function cycle() {
  await scheduler.heartbeat(workerId, 'claiming', { pid: process.pid });
  const jobs = await scheduler.claimDueJobs(workerId, 4);
  const results = [];
  for (const job of jobs) {
    try {
      await scheduler.heartbeat(workerId, `running:${job.name}`, {
        leaseUntil: job.locked_until?.toISOString?.() || job.locked_until
      });
      const result = await runWithLeaseRenewal(job, () => runAutomationJob(job.name, { config, repository, provider, pool, dataDir, year }));
      const status = result?.skipped ? 'skipped' : 'success';
      await scheduler.complete(job.name, workerId, result || {}, status);
      results.push({ name: job.name, status, result });
    } catch (error) {
      const recorded = await scheduler.fail(job.name, workerId, error).catch(() => null);
      results.push({ name: job.name, status: 'failed', error: error.message, leaseFailureRecorded: Boolean(recorded) });
    }
  }
  await scheduler.heartbeat(workerId, 'idle', { jobsProcessed: jobs.length });
  return results;
}

async function main() {
  await scheduler.configureJobs(jobDefinitions(config));
  if (runOnce) {
    const results = await cycle();
    console.log(JSON.stringify({ workerId, runOnce: true, results, status: await scheduler.status() }, null, 2));
    return;
  }
  console.log(JSON.stringify({ workerId, automation: true, pollSeconds: config.automationPollSeconds }));
  while (!stopping) {
    const results = await cycle();
    if (results.some(result => result.status === 'failed')) console.error(JSON.stringify({ workerId, results }));
    if (!stopping) await sleep(config.automationPollSeconds * 1000);
  }
}

for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { stopping = true; });

try {
  await main();
} finally {
  await pool.end();
}
