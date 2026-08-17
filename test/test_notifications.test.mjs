import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_NOTIFICATION_PREFIX,
  prepareTestNotification
} from '../src/workflow/test_notifications.mjs';
import { WorkflowService } from '../src/workflow/workflow_service.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { encryptText } from '../src/security/crypto.mjs';

function serviceFixture(config = {}) {
  const calls = [];
  const repository = {
    pool: {},
    queueTestNotification(args) { calls.push(args); return { id: '00000000-0000-4000-8000-000000000001', status: 'queued' }; },
    getTestNotificationStatus(args) { calls.push(args); return { id: args.notificationId, status: 'sent' }; }
  };
  return {
    calls,
    service: new WorkflowService({ repository, t3010Repository: null, config: {
      notificationProvider: 'disabled', emailProvider: 'disabled', ...config
    } })
  };
}

test('admin test notification normalizes, masks, prefixes and binds an email request', () => {
  const prepared = prepareTestNotification({
    channel: 'email',
    destination: ' JordanLegare4@GMAIL.com ',
    subject: 'Provider smoke',
    message: 'Confirming the configured email provider.',
    confirmation: 'SEND TEST EMAIL TO jordanlegare4@gmail.com'
  });
  assert.equal(prepared.destination, 'jordanlegare4@gmail.com');
  assert.equal(prepared.maskedDestination, 'jo••••••••@gmail.com');
  assert.equal(prepared.subject, 'Provider smoke');
  assert.equal(prepared.message, `${TEST_NOTIFICATION_PREFIX}\n\nConfirming the configured email provider.`);
  assert.match(prepared.requestDigest, /^[a-f0-9]{64}$/);
});

test('admin test notification normalizes E.164-compatible phone destinations', () => {
  for (const channel of ['sms', 'voice']) {
    const prepared = prepareTestNotification({
      channel,
      destination: '(416) 555-0123',
      message: 'Phone provider smoke.',
      confirmation: `SEND TEST ${channel.toUpperCase()} TO +14165550123`
    });
    assert.equal(prepared.destination, '+14165550123');
    assert.equal(prepared.maskedDestination, '•••-•••-0123');
  }
});

test('admin test notification rejects unsafe or mismatched input', () => {
  let confirmationError;
  try {
    prepareTestNotification({
      channel: 'email', destination: 'Private.Person@Example.ca', subject: '', message: 'test', confirmation: 'yes'
    });
  } catch (error) {
    confirmationError = error;
  }
  assert.match(confirmationError?.message || '', /Exact confirmation required/);
  assert.doesNotMatch(confirmationError.message, /private\.person@example\.ca/i);
  assert.throws(() => prepareTestNotification({
    channel: 'sms', destination: '+14165550123', subject: 'not allowed', message: 'test',
    confirmation: 'SEND TEST SMS TO +14165550123'
  }), /subject is supported only for email/);
  assert.throws(() => prepareTestNotification({
    channel: 'email', destination: 'test@example.ca', subject: '', message: 'x'.repeat(501),
    confirmation: 'SEND TEST EMAIL TO test@example.ca'
  }), /500 characters/);
});

test('request digest changes with any delivery semantic', () => {
  const emailBase = {
    channel: 'email', destination: 'test@example.ca', subject: 'Smoke', message: 'one',
    confirmation: 'SEND TEST EMAIL TO test@example.ca'
  };
  const first = prepareTestNotification(emailBase);
  const mutations = [
    prepareTestNotification({ ...emailBase, destination: 'other@example.ca', confirmation: 'SEND TEST EMAIL TO other@example.ca' }),
    prepareTestNotification({ ...emailBase, subject: 'Different subject' }),
    prepareTestNotification({ ...emailBase, message: 'two' }),
    prepareTestNotification({ channel: 'sms', destination: '+14165550123', subject: '', message: 'one', confirmation: 'SEND TEST SMS TO +14165550123' }),
    prepareTestNotification({ channel: 'voice', destination: '+14165550123', subject: '', message: 'one', confirmation: 'SEND TEST VOICE TO +14165550123' })
  ];
  for (const mutation of mutations) assert.notEqual(first.requestDigest, mutation.requestDigest);
  assert.notEqual(mutations[3].requestDigest, mutations[4].requestDigest);
});

test('only a global system administrator can queue or inspect a test notification', async () => {
  const { service } = serviceFixture({ emailProvider: 'resend' });
  const nonAdmin = { id: 'user-1', roles: [], memberships: [{ organizationId: 'org-1', role: 'recipient_admin' }] };
  await assert.rejects(service.queueTestNotification(nonAdmin, {
    channel: 'email', destination: 'test@example.ca', subject: '', message: 'test',
    confirmation: 'SEND TEST EMAIL TO test@example.ca', idempotencyKey: 'test-key-1'
  }), /lacks global role system_admin/);
  await assert.rejects(service.getTestNotificationStatus(nonAdmin, '00000000-0000-4000-8000-000000000001'), /lacks global role system_admin/);
});

test('service rejects each disabled channel provider before persistence', async () => {
  const admin = { id: 'admin-1', roles: ['system_admin'], memberships: [] };
  const { service, calls } = serviceFixture();
  const cases = [
    { channel: 'email', destination: 'test@example.ca', confirmation: 'SEND TEST EMAIL TO test@example.ca', error: /EMAIL_PROVIDER is disabled/ },
    { channel: 'sms', destination: '+14165550123', confirmation: 'SEND TEST SMS TO +14165550123', error: /NOTIFICATION_PROVIDER is disabled/ },
    { channel: 'voice', destination: '+14165550123', confirmation: 'SEND TEST VOICE TO +14165550123', error: /NOTIFICATION_PROVIDER is disabled/ }
  ];
  for (const entry of cases) {
    await assert.rejects(service.queueTestNotification(admin, {
      channel: entry.channel,
      destination: entry.destination,
      confirmation: entry.confirmation,
      subject: '',
      message: 'test',
      idempotencyKey: `test-key-${entry.channel}`
    }), entry.error);
  }
  assert.equal(calls.length, 0);
});

test('redacted test notification results disclose the fixed retry limit', () => {
  const encryptionKey = 'e'.repeat(40);
  const repository = new WorkflowRepository({ query() {} }, { encryptionKey, auditHmacKey: 'a'.repeat(40) });
  const result = repository.redactTestNotification({
    id: '00000000-0000-4000-8000-000000000001',
    channel: 'email',
    recipient: encryptText('private@example.ca', encryptionKey),
    subject: '',
    status: 'queued',
    attempts: 0,
    created_at: '2026-08-17T00:00:00.000Z'
  });
  assert.equal(result.retryLimit, 3);
});

test('system administrator can queue email, SMS and voice tests when each provider is enabled', async () => {
  const admin = { id: 'admin-1', roles: ['system_admin'], memberships: [] };
  const cases = [
    {
      config: { emailProvider: 'resend' },
      args: { channel: 'email', destination: 'test@example.ca', subject: 'Smoke', message: 'email', confirmation: 'SEND TEST EMAIL TO test@example.ca', idempotencyKey: 'email-key-1' }
    },
    {
      config: { notificationProvider: 'twilio' },
      args: { channel: 'sms', destination: '+14165550123', subject: '', message: 'sms', confirmation: 'SEND TEST SMS TO +14165550123', idempotencyKey: 'sms-key-1' }
    },
    {
      config: { notificationProvider: 'twilio' },
      args: { channel: 'voice', destination: '+14165550123', subject: '', message: 'voice', confirmation: 'SEND TEST VOICE TO +14165550123', idempotencyKey: 'voice-key-1' }
    }
  ];
  for (const entry of cases) {
    const { service, calls } = serviceFixture(entry.config);
    await service.queueTestNotification(admin, entry.args);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actor, admin);
    assert.equal(calls[0].notification.channel, entry.args.channel);
    assert.match(calls[0].notification.requestDigest, /^[a-f0-9]{64}$/);
    assert.equal(calls[0].idempotencyKey, entry.args.idempotencyKey);
  }
});
