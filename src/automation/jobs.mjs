import crypto from 'node:crypto';
import { decryptText } from '../security/crypto.mjs';
import { verifyAuditChain } from '../security/audit_verify.mjs';
import { ingestT3010 } from '../t3010/importer.mjs';
import { RESOURCE_KINDS } from '../t3010/constants.mjs';
import { ensureOfferAccess } from '../workflow/offer_access.mjs';
import { getContactChallengeForNotification } from '../workflow/recipient_contacts.mjs';
import { runOfferBatchesJob } from '../workflow/offer_batches.mjs';
import { refreshStatusVerificationTasks } from '../workflow/status_verification_tasks.mjs';
import { runAllocationPoliciesJob } from './allocation_policies.mjs';
import { runReviewBundlesJob } from './review_bundle_worker.mjs';

function offerMessage(notification, access) {
  const prefix = notification.channel === 'voice'
    ? 'A funding offer is available for your organization. This is not a request to submit an application. Your secure response link is '
    : 'A funding offer is available for your organization. No grant application is required. Review and respond securely: ';
  return `${prefix}${access.url} . The link expires ${new Date(access.expiresAt).toLocaleDateString('en-CA')}. Do not forward the link.`;
}

function contactVerificationMessage(notification, access) {
  const prefix = notification.channel === 'voice'
    ? `Verify this public contact channel for ${access.organizationName}. This verification does not accept a funding offer. Open `
    : `Verify this public contact channel for ${access.organizationName}. This verification does not accept a funding offer: `;
  return `${prefix}${access.url} . The link expires ${new Date(access.expiresAt).toLocaleDateString('en-CA')}. Do not forward the link.`;
}

export async function dispatchNotificationsJob({ config, repository, provider }) {
  if (config.notificationProvider === 'disabled') return { skipped: true, reason: 'notification_provider_disabled' };
  const lockToken = crypto.randomUUID();
  const queued = await repository.claimQueuedNotifications(config.notificationBatchSize, lockToken);
  let sent = 0;
  let failed = 0;
  let retried = 0;
  let secureOfferLinks = 0;
  let contactVerificationLinks = 0;
  for (const notification of queued) {
    try {
      const to = decryptText(notification.recipient, config.encryptionKey);
      let body = notification.payload?.message || 'A funding offer is available for your organization.';
      if (notification.template === 'grant_offer' && config.recipientPortalEnabled) {
        if (!notification.grant_id) throw new Error('Grant-offer notification is missing grant_id.');
        const access = await ensureOfferAccess({
          repository,
          grantId: notification.grant_id,
          portalBaseUrl: config.recipientPortalBaseUrl,
          ttlHours: config.offerTokenTtlHours,
          requestId: `notification:${notification.id}`
        });
        body = offerMessage(notification, access);
        secureOfferLinks += 1;
      } else if (notification.template === 'contact_verification' && config.recipientPortalEnabled) {
        if (!notification.payload?.challengeId) throw new Error('Contact-verification notification is missing challengeId.');
        const access = await getContactChallengeForNotification(repository, notification.payload.challengeId, config.recipientPortalBaseUrl);
        body = contactVerificationMessage(notification, access);
        contactVerificationLinks += 1;
      }
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
  return { processed: queued.length, sent, failed, retried, secureOfferLinks, contactVerificationLinks };
}

export async function syncT3010Job({ config, dataDir, year }) {
  if (!config.enableT3010Sync) return { skipped: true, reason: 't3010_sync_disabled' };
  const manifest = await ingestT3010({ year, outputDir: dataDir, resources: RESOURCE_KINDS, maxRows: 0 });
  return { year: manifest.year, datasetId: manifest.datasetId, resources: manifest.resources?.length || 0, completedAt: new Date().toISOString() };
}

export async function statusEvidenceJob({ config, repository }) {
  return refreshStatusVerificationTasks({ config, repository, limit: 100 });
}

export async function auditIntegrityJob({ config, pool }) {
  if (!config.auditHmacKey) return { skipped: true, reason: 'audit_hmac_key_not_configured' };
  const result = await verifyAuditChain(pool, config.auditHmacKey);
  if (!result.valid) {
    const error = new Error(`Audit-chain verification failed at sequence ${result.failureSequence}: ${result.reason}`);
    error.auditIntegrity = result;
    throw error;
  }
  return result;
}

export async function maintenanceJob({ pool }) {
  const [notifications, tokens, workers] = await Promise.all([
    pool.query(`UPDATE notification_outbox SET locked_at=NULL, lock_token=NULL WHERE status='queued' AND locked_at < now() - interval '15 minutes' RETURNING id`),
    pool.query(`UPDATE offer_access_tokens SET revoked_at=COALESCE(revoked_at, now()) WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at < now() RETURNING id`),
    pool.query("DELETE FROM automation_worker_heartbeats WHERE heartbeat_at < now() - interval '7 days' RETURNING worker_id")
  ]);
  return { recoveredNotificationLocks: notifications.rowCount, retiredExpiredOfferTokens: tokens.rowCount, removedOldWorkerHeartbeats: workers.rowCount };
}

export async function runAutomationJob(name, context) {
  if (name === 'allocation_policies') return runAllocationPoliciesJob(context);
  if (name === 'review_bundles') return runReviewBundlesJob(context);
  if (name === 'offer_batches') return runOfferBatchesJob(context);
  if (name === 'status_evidence') return statusEvidenceJob(context);
  if (name === 'notifications') return dispatchNotificationsJob(context);
  if (name === 't3010_sync') return syncT3010Job(context);
  if (name === 'audit_integrity') return auditIntegrityJob(context);
  if (name === 'maintenance') return maintenanceJob(context);
  throw new Error(`Unknown automation job: ${name}`);
}
