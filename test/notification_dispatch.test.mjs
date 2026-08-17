import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dispatchNotificationsJob } from '../src/automation/jobs.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { createNotificationProvider } from '../src/integrations/notification.mjs';
import { encryptText } from '../src/security/crypto.mjs';
import { prepareTestNotification } from '../src/workflow/test_notifications.mjs';

const encryptionKey = 'e'.repeat(40);
const auditHmacKey = 'a'.repeat(40);

function queuedNotification(id, channel, destination, overrides = {}) {
  return {
    id,
    channel,
    recipient: encryptText(destination, encryptionKey),
    template: 'admin_test',
    payload: { message: `test ${channel}` },
    subject: channel === 'email' ? 'Provider test' : null,
    idempotency_key: `caller-secret-${channel}`,
    status: 'queued',
    attempts: 0,
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    ...overrides
  };
}

function memoryRepository(notifications) {
  return {
    async claimQueuedNotifications(limit, lockToken, { channels, notificationIds } = {}) {
      return notifications
        .filter(item => item.status === 'queued')
        .filter(item => !channels || channels.includes(item.channel))
        .filter(item => !notificationIds || notificationIds.includes(item.id))
        .slice(0, limit)
        .map(item => {
          item.attempts += 1;
          item.lockToken = lockToken;
          return { ...item };
        });
    },
    async markNotificationSent(id, providerMessageId) {
      const item = notifications.find(entry => entry.id === id);
      item.status = 'sent';
      item.providerMessageId = providerMessageId;
    },
    async markNotificationFailed(id, lastError, lockToken, retry) {
      const item = notifications.find(entry => entry.id === id);
      item.status = retry ? 'queued' : 'failed';
      item.lastError = lastError;
      item.failureArgs = { lastError, lockToken, retry };
    }
  };
}

test('email-only dispatch leaves phone rows queued without consuming attempts', async () => {
  const notifications = [
    queuedNotification('00000000-0000-4000-8000-000000000001', 'email', 'admin@example.ca'),
    queuedNotification('00000000-0000-4000-8000-000000000002', 'sms', '+14165550123'),
    queuedNotification('00000000-0000-4000-8000-000000000003', 'voice', '+14165550123')
  ];
  const delivered = [];
  const result = await dispatchNotificationsJob({
    config: { emailProvider: 'test', notificationProvider: 'disabled', notificationBatchSize: 25, encryptionKey },
    repository: memoryRepository(notifications),
    provider: { async send(message) { delivered.push(message); return { providerMessageId: 'email-1' }; } }
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(delivered.map(message => message.channel), ['email']);
  assert.deepEqual(notifications.map(item => [item.status, item.attempts]), [
    ['sent', 1], ['queued', 0], ['queued', 0]
  ]);
});

test('phone-only dispatch leaves email rows queued without consuming attempts', async () => {
  const notifications = [
    queuedNotification('00000000-0000-4000-8000-000000000011', 'email', 'admin@example.ca'),
    queuedNotification('00000000-0000-4000-8000-000000000012', 'sms', '+14165550123'),
    queuedNotification('00000000-0000-4000-8000-000000000013', 'voice', '+14165550123')
  ];
  const delivered = [];
  const result = await dispatchNotificationsJob({
    config: { emailProvider: 'disabled', notificationProvider: 'test', notificationBatchSize: 25, encryptionKey },
    repository: memoryRepository(notifications),
    provider: { async send(message) { delivered.push(message); return { providerMessageId: `phone-${message.channel}` }; } }
  });
  assert.equal(result.sent, 2);
  assert.deepEqual(delivered.map(message => message.channel), ['sms', 'voice']);
  assert.deepEqual(notifications.map(item => [item.status, item.attempts]), [
    ['queued', 0], ['sent', 1], ['sent', 1]
  ]);
});

test('notification dispatch isolates admin caller keys without changing existing workflow provider keys', async () => {
  const adminTest = queuedNotification('00000000-0000-4000-8000-000000000021', 'email', 'admin@example.ca');
  const grantOffer = queuedNotification('00000000-0000-4000-8000-000000000022', 'email', 'recipient@example.ca', {
    template: 'grant_offer',
    idempotency_key: 'legacy-grant-offer-key'
  });
  const contactVerification = queuedNotification('00000000-0000-4000-8000-000000000023', 'email', 'contact@example.ca', {
    template: 'contact_verification',
    idempotency_key: 'legacy-contact-verification-key'
  });
  const delivered = [];
  await dispatchNotificationsJob({
    config: { emailProvider: 'test', notificationProvider: 'disabled', notificationBatchSize: 25, encryptionKey },
    repository: memoryRepository([adminTest, grantOffer, contactVerification]),
    provider: { async send(message) { delivered.push(message); return { providerMessageId: 'email-2' }; } }
  });
  assert.equal(delivered[0].subject, 'Provider test');
  assert.equal(delivered[0].idempotencyKey, adminTest.id);
  assert.doesNotMatch(delivered[0].idempotencyKey, /caller-secret/);
  assert.equal(delivered[1].idempotencyKey, 'legacy-grant-offer-key');
  assert.equal(delivered[2].idempotencyKey, 'legacy-contact-verification-key');
});

test('unknown provider failures persist only a generic allowlisted summary', async () => {
  const notification = queuedNotification('00000000-0000-4000-8000-000000000031', 'sms', '+14165550123', {
    attempts: 2,
    idempotency_key: 'caller-key-ultra-secret'
  });
  const repository = memoryRepository([notification]);
  await dispatchNotificationsJob({
    config: { emailProvider: 'disabled', notificationProvider: 'test', notificationBatchSize: 25, encryptionKey },
    repository,
    provider: {
      async send() {
        throw new Error('third party said 416-555-0123 caller-key-ultra-secret arbitrary-provider-secret');
      }
    }
  });
  assert.equal(notification.lastError, 'Notification delivery failed.');
  assert.doesNotMatch(notification.failureArgs.lastError, /416-555-0123|caller-key|arbitrary-provider-secret/);
  assert.deepEqual(Object.keys(notification.failureArgs).sort(), ['lastError', 'lockToken', 'retry']);
});

test('repository claim contract filters channels and explicit fixture ids before incrementing attempts', async () => {
  let selectedQuery = null;
  let selectedParams = null;
  const client = {
    async query(sql, params = []) {
      if (String(sql).includes('SELECT id FROM notification_outbox')) {
        selectedQuery = String(sql);
        selectedParams = params;
      }
      return { rows: [] };
    },
    release() {}
  };
  const repository = new WorkflowRepository({ async connect() { return client; } }, { encryptionKey, auditHmacKey });
  const fixtureId = '00000000-0000-4000-8000-000000000041';
  await repository.claimQueuedNotifications(25, 'opaque-lock', { channels: ['email'], notificationIds: [fixtureId] });
  assert.match(selectedQuery, /channel\s*=\s*ANY/i);
  assert.match(selectedQuery, /id\s*=\s*ANY/i);
  assert.deepEqual(selectedParams, [25, ['email'], [fixtureId]]);
});

test('admin test persistence stores only a keyed semantic signature and returns retry metadata', async () => {
  let insertedRow = null;
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes("WHERE template='admin_test' AND idempotency_key=$1")) return { rows: insertedRow ? [insertedRow] : [] };
      if (text.includes('SELECT count(*) AS n')) return { rows: [{ n: '0' }] };
      if (text.includes('INSERT INTO notification_outbox')) {
        insertedRow = {
          id: '00000000-0000-4000-8000-000000000051',
          channel: params[0],
          recipient: params[1],
          template: 'admin_test',
          payload: JSON.parse(params[2]),
          subject: params[3],
          idempotency_key: params[4],
          created_by: params[5],
          status: 'queued',
          attempts: 0,
          created_at: new Date('2026-08-17T00:00:00.000Z')
        };
        return { rows: [insertedRow] };
      }
      if (text.includes('SELECT entry_hmac FROM audit_log')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const repository = new WorkflowRepository({ async connect() { return client; } }, { encryptionKey, auditHmacKey });
  const prepared = prepareTestNotification({
    channel: 'email', destination: 'private@example.ca', subject: 'Smoke', message: 'test',
    confirmation: 'SEND TEST EMAIL TO private@example.ca'
  });
  const actor = { id: '00000000-0000-4000-8000-000000000052' };
  const queued = await repository.queueTestNotification({ actor, notification: prepared, idempotencyKey: 'private-caller-key' });
  assert.match(insertedRow.payload.requestSignature, /^[a-f0-9]{64}$/);
  assert.equal(insertedRow.payload.requestDigest, undefined);
  assert.notEqual(insertedRow.payload.requestSignature, prepared.requestDigest);
  assert.equal(queued.retryLimit, 3);
  const replay = await repository.queueTestNotification({ actor, notification: prepared, idempotencyKey: 'private-caller-key' });
  assert.equal(replay.id, queued.id);
  await assert.rejects(repository.queueTestNotification({
    actor, notification: { ...prepared, requestDigest: 'f'.repeat(64) }, idempotencyKey: 'private-caller-key'
  }), /different test notification semantics/i);
});

test('provider adapters discard arbitrary third-party response text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    async json() { return { message: '416-555-0123 caller-key arbitrary-provider-secret' }; }
  });
  try {
    const email = createNotificationProvider({
      emailProvider: 'resend', resendApiKey: 'fake', resendFromEmail: 'sender@example.ca', notificationProvider: 'disabled'
    });
    await assert.rejects(email.send({
      channel: 'email', to: 'private@example.ca', subject: 'test', body: 'test', idempotencyKey: 'caller-key'
    }), error => {
      assert.equal(error.code, 'RESEND_REQUEST_FAILED');
      assert.doesNotMatch(error.message, /416-555-0123|caller-key|arbitrary-provider-secret/);
      return true;
    });

    const phone = createNotificationProvider({
      emailProvider: 'disabled', notificationProvider: 'twilio', twilioAccountSid: 'fake', twilioAuthToken: 'fake', twilioFromNumber: '+14165550000'
    });
    await assert.rejects(phone.send({ channel: 'sms', to: '+14165550123', body: 'test' }), error => {
      assert.equal(error.code, 'TWILIO_REQUEST_FAILED');
      assert.doesNotMatch(error.message, /416-555-0123|caller-key|arbitrary-provider-secret/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin notification database smoke requires disposable acknowledgement and explicit secrets', () => {
  const run = extraEnv => spawnSync(process.execPath, ['scripts/admin-test-notification-db-smoke.mjs'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, ...extraEnv },
    encoding: 'utf8'
  });
  const noAcknowledgement = run({ DATABASE_URL: 'postgres://unused', ENCRYPTION_KEY: encryptionKey, AUDIT_HMAC_KEY: auditHmacKey });
  assert.notEqual(noAcknowledgement.status, 0);
  assert.match(noAcknowledgement.stderr, /ADMIN_NOTIFICATION_DB_SMOKE_DISPOSABLE=1/);

  const noEncryptionKey = run({ ADMIN_NOTIFICATION_DB_SMOKE_DISPOSABLE: '1', DATABASE_URL: 'postgres://unused' });
  assert.match(noEncryptionKey.stderr, /ENCRYPTION_KEY is required/);

  const noAuditKey = run({ ADMIN_NOTIFICATION_DB_SMOKE_DISPOSABLE: '1', DATABASE_URL: 'postgres://unused', ENCRYPTION_KEY: encryptionKey });
  assert.match(noAuditKey.stderr, /AUDIT_HMAC_KEY is required/);

  const noDatabase = run({ ADMIN_NOTIFICATION_DB_SMOKE_DISPOSABLE: '1', ENCRYPTION_KEY: encryptionKey, AUDIT_HMAC_KEY: auditHmacKey });
  assert.match(noDatabase.stderr, /DATABASE_URL is required/);
});
