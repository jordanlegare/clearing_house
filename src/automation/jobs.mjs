import crypto from 'node:crypto';
import { decryptText } from '../security/crypto.mjs';
import { ingestT3010 } from '../t3010/importer.mjs';
import { RESOURCE_KINDS } from '../t3010/constants.mjs';

export async function dispatchNotificationsJob({ config, repository, provider }) {
  if (config.notificationProvider === 'disabled') return { skipped: true, reason: 'notification_provider_disabled' };
  const lockToken = crypto.randomUUID();
  const queued = await repository.claimQueuedNotifications(config.notificationBatchSize, lockToken);
  let sent = 0;
  let failed = 0;
  let retried = 0;
  for (const notification of queued) {
    try {
      const to = decryptText(notification.recipient, config.encryptionKey);
      const body = notification.payload?.message || 'A funding offer is available for your organization.';
      const delivered = await provider.send({ channel: notification.channel, to, body });
      await repository.markNotificationSent(notification.id, delivered.providerMessageId, lockToken);
      sent += 1;
    } catch (error) {
      const retry = notification.attempts < 3;
      await repository.markNotificationFailed(notification.id, error.message, lockToken, retry);
      failed += 1;
      if (retry) retried += 1;
    }
  }
  return { processed: queued.length, sent, failed, retried };
}

export async function syncT3010Job({ config, dataDir, year }) {
  if (!config.enableT3010Sync) return { skipped: true, reason: 't3010_sync_disabled' };
  const manifest = await ingestT3010({
    year,
    outputDir: dataDir,
    resources: RESOURCE_KINDS,
    maxRows: 0
  });
  return {
    year: manifest.year,
    datasetId: manifest.datasetId,
    resources: manifest.resources?.length || 0,
    completedAt: new Date().toISOString()
  };
}

export async function maintenanceJob({ pool }) {
  const [notifications, tokens, workers] = await Promise.all([
    pool.query(`
      UPDATE notification_outbox
      SET locked_at=NULL, lock_token=NULL
      WHERE status='queued' AND locked_at < now() - interval '15 minutes'
      RETURNING id
    `),
    pool.query(`
      UPDATE offer_access_tokens
      SET used_at=COALESCE(used_at, now())
      WHERE used_at IS NULL AND expires_at < now() - interval '30 days'
      RETURNING id
    `),
    pool.query("DELETE FROM automation_worker_heartbeats WHERE heartbeat_at < now() - interval '7 days' RETURNING worker_id")
  ]);
  return {
    recoveredNotificationLocks: notifications.rowCount,
    retiredExpiredOfferTokens: tokens.rowCount,
    removedOldWorkerHeartbeats: workers.rowCount
  };
}

export async function runAutomationJob(name, context) {
  if (name === 'notifications') return dispatchNotificationsJob(context);
  if (name === 't3010_sync') return syncT3010Job(context);
  if (name === 'maintenance') return maintenanceJob(context);
  throw new Error(`Unknown automation job: ${name}`);
}
