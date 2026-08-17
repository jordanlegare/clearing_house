import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';
import { createNotificationProvider } from '../src/integrations/notification.mjs';
import { dispatchNotificationsJob } from '../src/automation/jobs.mjs';

const config = loadRuntimeConfig();
const readiness = assessReadiness(config);
if (!readiness.ready) {
  console.error(JSON.stringify(readiness, null, 2));
  process.exit(2);
}
if (!config.databaseUrl) throw new Error('DATABASE_URL is required.');
if (config.notificationProvider === 'disabled' && config.emailProvider === 'disabled') throw new Error('All notification providers are disabled.');

const pool = createDatabasePool(config.databaseUrl);
const repository = new WorkflowRepository(pool, { auditHmacKey: config.auditHmacKey, encryptionKey: config.encryptionKey });
const provider = createNotificationProvider(config);

let summary;
try {
  const result = await dispatchNotificationsJob({ config, repository, provider });
  summary = { processed: result.processed || 0, sent: result.sent || 0, failed: result.failed || 0 };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}
if (summary.failed) process.exitCode = 1;
