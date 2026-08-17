import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { dispatchNotificationsJob } from '../src/automation/jobs.mjs';
import { prepareTestNotification } from '../src/workflow/test_notifications.mjs';
import { payloadDigest } from '../src/security/audit.mjs';

if (process.env.ADMIN_NOTIFICATION_DB_SMOKE_DISPOSABLE !== '1') {
  throw new Error('ADMIN_NOTIFICATION_DB_SMOKE_DISPOSABLE=1 is required to acknowledge a disposable test database.');
}
const encryptionKey = process.env.ENCRYPTION_KEY;
if (!encryptionKey || encryptionKey.length < 32) throw new Error('ENCRYPTION_KEY is required and must be at least 32 characters.');
const auditHmacKey = process.env.AUDIT_HMAC_KEY;
if (!auditHmacKey || auditHmacKey.length < 32) throw new Error('AUDIT_HMAC_KEY is required and must be at least 32 characters.');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const suffix = crypto.randomUUID();
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { encryptionKey, auditHmacKey });

async function systemAdmin(label) {
  let actor = await repository.upsertActorFromClaims({ subject: `admin-test-${label}-${suffix}`, email: `${label}-${suffix}@example.ca` });
  await pool.query("INSERT INTO user_global_roles (user_id,role) VALUES ($1,'system_admin') ON CONFLICT DO NOTHING", [actor.id]);
  return repository.upsertActorFromClaims({ subject: `admin-test-${label}-${suffix}` });
}

const admin = await systemAdmin('primary');
const otherAdmin = await systemAdmin('other');
const prepared = prepareTestNotification({
  channel: 'email', destination: 'jordanlegare4@gmail.com', subject: 'Provider smoke', message: 'Synthetic database smoke.',
  confirmation: 'SEND TEST EMAIL TO jordanlegare4@gmail.com'
});

try {
  const queued = await repository.queueTestNotification({
    actor: admin,
    notification: prepared,
    idempotencyKey: `admin-smoke-${suffix}`
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.destination, prepared.maskedDestination);

  const raw = (await pool.query('SELECT * FROM notification_outbox WHERE id=$1', [queued.id])).rows[0];
  assert.equal(raw.grant_id, null);
  assert.equal(raw.created_by, admin.id);
  assert.equal(raw.template, 'admin_test');
  assert.notEqual(raw.recipient, prepared.destination);
  assert.match(raw.payload.requestSignature, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(raw.payload, 'requestDigest'), false);
  assert.notEqual(raw.payload.requestSignature, prepared.requestDigest);
  assert.equal(queued.retryLimit, 3);

  const replay = await repository.queueTestNotification({
    actor: admin,
    notification: prepared,
    idempotencyKey: `admin-smoke-${suffix}`
  });
  assert.equal(replay.id, queued.id);

  await assert.rejects(repository.queueTestNotification({
    actor: admin,
    notification: { ...prepared, requestDigest: 'f'.repeat(64) },
    idempotencyKey: `admin-smoke-${suffix}`
  }), /idempotency key was already used for different test notification semantics/i);

  await assert.rejects(
    repository.getTestNotificationStatus({ actor: otherAdmin, notificationId: queued.id }),
    /not found/i
  );

  const delivered = [];
  const dispatch = await dispatchNotificationsJob({
    config: { notificationProvider: 'disabled', emailProvider: 'test', notificationBatchSize: 25, encryptionKey },
    repository,
    provider: { async send(message) { delivered.push(message); return { providerMessageId: 'email_test_1' }; } },
    notificationIds: [queued.id]
  });
  assert.equal(dispatch.sent, 1);
  assert.equal(delivered[0].to, prepared.destination);

  const sent = await repository.getTestNotificationStatus({ actor: admin, notificationId: queued.id });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.providerMessageId, 'email_test_1');
  assert.equal(sent.destination, prepared.maskedDestination);
  assert.equal(sent.retryLimit, 3);

  const rateNotifications = [];
  for (let index = 1; index <= 4; index += 1) {
    rateNotifications.push(await repository.queueTestNotification({
      actor: admin,
      notification: prepared,
      idempotencyKey: `admin-rate-${suffix}-${index}`
    }));
  }
  await assert.rejects(
    repository.queueTestNotification({ actor: admin, notification: prepared, idempotencyKey: `admin-rate-${suffix}-6` }),
    /five test notifications per hour/i
  );

  await dispatchNotificationsJob({
    config: { notificationProvider: 'disabled', emailProvider: 'test', notificationBatchSize: 25, encryptionKey },
    repository,
    provider: { async send() { return { providerMessageId: 'rate-flush' }; } },
    notificationIds: rateNotifications.map(notification => notification.id)
  });

  const recovering = await repository.queueTestNotification({
    actor: otherAdmin,
    notification: prepared,
    idempotencyKey: `admin-recovery-${suffix}`
  });
  await dispatchNotificationsJob({
    config: { notificationProvider: 'disabled', emailProvider: 'test', notificationBatchSize: 1, encryptionKey },
    repository,
    provider: { async send() { throw new Error(`synthetic recovery failure for ${prepared.destination}`); } },
    notificationIds: [recovering.id]
  });
  const recoveryFailed = await repository.getTestNotificationStatus({ actor: otherAdmin, notificationId: recovering.id });
  assert.equal(recoveryFailed.status, 'queued');
  assert.equal(recoveryFailed.attempts, 1);
  assert.ok(recoveryFailed.lastError);
  const recoveryRaw = (await pool.query('SELECT payload FROM notification_outbox WHERE id=$1', [recovering.id])).rows[0];
  assert.equal(recoveryRaw.payload.deliveryError, undefined);
  const recoveryAudit = (await pool.query(
    "SELECT action,payload_digest FROM audit_log WHERE resource_type='notification' AND resource_id=$1 ORDER BY sequence DESC LIMIT 1",
    [recovering.id]
  )).rows[0];
  assert.equal(recoveryAudit.action, 'notification.retry');
  assert.equal(recoveryAudit.payload_digest, payloadDigest({ retry: true }));

  await dispatchNotificationsJob({
    config: { notificationProvider: 'disabled', emailProvider: 'test', notificationBatchSize: 1, encryptionKey },
    repository,
    provider: { async send() { return { providerMessageId: 'recovery-success' }; } },
    notificationIds: [recovering.id]
  });
  const recovered = await repository.getTestNotificationStatus({ actor: otherAdmin, notificationId: recovering.id });
  assert.equal(recovered.status, 'sent');
  assert.equal(recovered.lastError, null);

  const failing = await repository.queueTestNotification({
    actor: otherAdmin,
    notification: prepared,
    idempotencyKey: `admin-failure-${suffix}`
  });
  for (const expected of [
    { attempts: 1, status: 'queued' },
    { attempts: 2, status: 'queued' },
    { attempts: 3, status: 'failed' }
  ]) {
    await dispatchNotificationsJob({
      config: { notificationProvider: 'disabled', emailProvider: 'test', notificationBatchSize: 1, encryptionKey },
      repository,
      provider: { async send() { throw new Error(`416-555-0123 admin-failure-${suffix} arbitrary-provider-secret ${'x'.repeat(1200)}`); } },
      notificationIds: [failing.id]
    });
    const state = await repository.getTestNotificationStatus({ actor: otherAdmin, notificationId: failing.id });
    assert.equal(state.attempts, expected.attempts);
    assert.equal(state.status, expected.status);
    assert.ok(state.lastError.length <= 1000);
    assert.doesNotMatch(state.lastError, /416-555-0123|admin-failure-|arbitrary-provider-secret/);
    const failedRaw = (await pool.query('SELECT payload FROM notification_outbox WHERE id=$1', [failing.id])).rows[0];
    assert.equal(failedRaw.payload.deliveryError, undefined);
    const failureAudit = (await pool.query(
      "SELECT action,payload_digest FROM audit_log WHERE resource_type='notification' AND resource_id=$1 ORDER BY sequence DESC LIMIT 1",
      [failing.id]
    )).rows[0];
    assert.equal(failureAudit.action, expected.status === 'queued' ? 'notification.retry' : 'notification.failed');
    assert.equal(failureAudit.payload_digest, payloadDigest({ retry: expected.status === 'queued' }));
  }

  const audit = await pool.query(
    "SELECT action,request_id FROM audit_log WHERE resource_type='notification' AND resource_id=$1 ORDER BY sequence",
    [queued.id]
  );
  assert.ok(audit.rows.some(row => row.action === 'notification.test_queued'));
  const queuedAudit = audit.rows.find(row => row.action === 'notification.test_queued');
  assert.equal(queuedAudit.request_id.includes(prepared.destination), false);
  assert.match(queuedAudit.request_id, /^admin-test:[a-f0-9]{64}$/);
  console.log(JSON.stringify({ queued: true, sent: true, rateLimited: true, retried: true, failed: true, errorCleared: true, auditRecorded: true }));
} finally {
  await pool.end();
}
