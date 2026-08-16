import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';
import { createNotificationProvider } from '../src/integrations/notification.mjs';
import { decryptText } from '../src/security/crypto.mjs';
import crypto from 'node:crypto';

const config = loadRuntimeConfig();
const readiness = assessReadiness(config);
if (!readiness.ready) {
  console.error(JSON.stringify(readiness, null, 2));
  process.exit(2);
}
if (!config.databaseUrl) throw new Error('DATABASE_URL is required.');
if (config.notificationProvider === 'disabled') throw new Error('NOTIFICATION_PROVIDER is disabled.');

const pool = createDatabasePool(config.databaseUrl);
const repository = new WorkflowRepository(pool, { auditHmacKey: config.auditHmacKey, encryptionKey: config.encryptionKey });
const provider = createNotificationProvider(config);

let sent = 0;
let failed = 0;
try {
  const lockToken = crypto.randomUUID();
  const queued = await repository.claimQueuedNotifications(config.notificationBatchSize, lockToken);
  for (const notification of queued) {
    try {
      const to = decryptText(notification.recipient, config.encryptionKey);
      const body = notification.payload?.message || 'A funding offer is available for your organization.';
      const delivered = await provider.send({ channel: notification.channel, to, body });
      await repository.markNotificationSent(notification.id, delivered.providerMessageId, lockToken);
      sent += 1;
    } catch (error) {
      await repository.markNotificationFailed(notification.id, error.message, lockToken, notification.attempts < 3);
      failed += 1;
    }
  }
  console.log(JSON.stringify({ processed: sent + failed, sent, failed }, null, 2));
} finally {
  await pool.end();
}
if (failed) process.exitCode = 1;
