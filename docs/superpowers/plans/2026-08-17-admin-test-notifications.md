# Admin Test Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add system-admin-only email, SMS, and voice delivery tests that traverse the encrypted notification outbox, autonomous worker, provider adapter, retries, and audit chain without creating grant records.

**Architecture:** A focused workflow module normalizes and binds test requests. `WorkflowService` enforces global system-admin authorization and provider availability, while `WorkflowRepository` enforces transactional idempotency and rate limits and persists encrypted outbox rows. Two authenticated MCP tools queue and inspect tests; the existing worker dispatches them after its email-only enablement bug is corrected.

**Tech Stack:** Node.js 22 ESM, Model Context Protocol SDK, Zod, PostgreSQL 16, `node:test`, existing AES-GCM recipient encryption and HMAC audit chain.

## Global Constraints

- Only actors with the global `system_admin` role may queue or inspect test notifications.
- Supported channels are exactly `email`, `sms`, and `voice`.
- Messages are plain text, contain at most 500 caller-supplied characters, and receive the fixed prefix `Clearing House delivery test — no grant action is required.`
- Email subjects contain at most 120 characters; SMS and voice reject non-empty subjects.
- Confirmation is exactly `SEND TEST <CHANNEL> TO <NORMALIZED_DESTINATION>`.
- Destinations are encrypted at rest and never appear raw in audit records, logs, or MCP results.
- Each administrator may queue at most five new tests in a rolling hour.
- Stored idempotency keys are scoped to the administrator and semantic mismatches are rejected.
- Tests use fake providers only. A real delivery to `jordanlegare4@gmail.com` occurs only after deployment and explicit invocation.
- Add no runtime dependency.

---

## File Structure

- Create `src/workflow/test_notifications.mjs`: pure normalization, confirmation, prefix, masking, and request-digest functions.
- Create `test/test_notifications.test.mjs`: pure validation and service authorization/provider-availability tests.
- Create `db/migrations/016_admin_test_notifications.sql`: outbox creator ownership and rate-limit index.
- Modify `src/db/workflow_repository.mjs`: transactional queue and redacted status operations; bounded failure persistence.
- Modify `src/automation/jobs.mjs`: remove raw destinations from provider errors before persistence and audit.
- Create `scripts/admin-test-notification-db-smoke.mjs`: PostgreSQL queue, encryption, audit, idempotency, rate-limit, retry, and status smoke.
- Modify `src/workflow/workflow_service.mjs`: system-admin service methods and provider checks.
- Modify `src/mcp/workflow_tools.mjs`: authenticated queue and status tools.
- Modify `test/workflow_tools.test.mjs`: tool presence and annotations.
- Modify `src/automation/scheduler.mjs`: enable offer and notification jobs for phone or email providers.
- Modify `scripts/autonomous-worker.mjs`: construct a provider when phone or email is enabled.
- Modify `scripts/dispatch-notifications.mjs`: allow email-only manual dispatch.
- Modify `src/db/schema_readiness.mjs`: require the outbox creator column used by the feature.
- Modify `test/automation.test.mjs`: provider enablement matrix.
- Modify `package.json`: syntax-check and database-smoke commands.
- Modify `.github/workflows/ci.yml`: run the database smoke.
- Modify `.github/workflows/verified-contact-offers.yml`: syntax-check the new module/script.
- Modify `README.md`: document the admin tools, limits, provider behavior, and live test procedure.

---

### Task 1: Pure Test-Notification Request Boundary

**Files:**
- Create: `src/workflow/test_notifications.mjs`
- Create: `test/test_notifications.test.mjs`

**Interfaces:**
- Produces: `TEST_NOTIFICATION_PREFIX: string`
- Produces: `maskTestDestination(channel, destination): string`
- Produces: `prepareTestNotification(input): { channel, destination, maskedDestination, subject, message, requestDigest }`
- Consumes: `normalizeContactDestination(channel, destination)` from `src/workflow/recipient_contacts.mjs`

- [ ] **Step 1: Write failing normalization, confirmation, and digest tests**

Create `test/test_notifications.test.mjs` with these cases:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_NOTIFICATION_PREFIX,
  prepareTestNotification
} from '../src/workflow/test_notifications.mjs';

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
  assert.throws(() => prepareTestNotification({
    channel: 'email', destination: 'test@example.ca', subject: '', message: 'test', confirmation: 'yes'
  }), /Exact confirmation required/);
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
  const base = {
    channel: 'email', destination: 'test@example.ca', subject: 'Smoke', message: 'one',
    confirmation: 'SEND TEST EMAIL TO test@example.ca'
  };
  const first = prepareTestNotification(base);
  const second = prepareTestNotification({ ...base, message: 'two' });
  assert.notEqual(first.requestDigest, second.requestDigest);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run:

```bash
node --test test/test_notifications.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/workflow/test_notifications.mjs`.

- [ ] **Step 3: Implement the pure request boundary**

Create `src/workflow/test_notifications.mjs`:

```js
import crypto from 'node:crypto';
import { normalizeContactDestination } from './recipient_contacts.mjs';

export const TEST_NOTIFICATION_PREFIX = 'Clearing House delivery test — no grant action is required.';

export function maskTestDestination(channel, destination) {
  if (channel === 'email') {
    const [local, domain] = destination.split('@');
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${'•'.repeat(Math.min(Math.max(local.length - visible.length, 2), 8))}@${domain}`;
  }
  return `•••-•••-${destination.replace(/\D/g, '').slice(-4)}`;
}

export function prepareTestNotification({ channel, destination, subject = '', message, confirmation }) {
  if (!['email', 'sms', 'voice'].includes(channel)) throw new Error('Test notification channel must be email, sms, or voice.');
  const normalizedDestination = normalizeContactDestination(channel, destination);
  const normalizedSubject = String(subject || '').trim();
  const normalizedMessage = String(message || '').trim();
  if (!normalizedMessage) throw new Error('Test notification message is required.');
  if (normalizedMessage.length > 500) throw new Error('Test notification message cannot exceed 500 characters.');
  if (normalizedSubject.length > 120) throw new Error('Test notification subject cannot exceed 120 characters.');
  if (channel !== 'email' && normalizedSubject) throw new Error('A subject is supported only for email test notifications.');
  const expected = `SEND TEST ${channel.toUpperCase()} TO ${normalizedDestination}`;
  if (confirmation !== expected) throw new Error(`Exact confirmation required: ${expected}`);
  const requestDigest = crypto.createHash('sha256').update(JSON.stringify({
    channel,
    destination: normalizedDestination,
    subject: normalizedSubject,
    message: normalizedMessage
  })).digest('hex');
  return {
    channel,
    destination: normalizedDestination,
    maskedDestination: maskTestDestination(channel, normalizedDestination),
    subject: normalizedSubject,
    message: `${TEST_NOTIFICATION_PREFIX}\n\n${normalizedMessage}`,
    requestDigest
  };
}
```

- [ ] **Step 4: Run the focused test and full unit suite**

Run:

```bash
node --test test/test_notifications.test.mjs
node --test test/*.test.mjs
```

Expected: the focused file passes 4 tests and the full unit suite reports zero failures.

- [ ] **Step 5: Commit the request boundary**

```bash
git add src/workflow/test_notifications.mjs test/test_notifications.test.mjs
git commit -m "Add test notification request boundary"
```

---

### Task 2: Transactional Outbox Persistence and Database Smoke

**Files:**
- Create: `db/migrations/016_admin_test_notifications.sql`
- Modify: `src/db/workflow_repository.mjs`
- Modify: `src/automation/jobs.mjs`
- Modify: `src/db/schema_readiness.mjs`
- Create: `scripts/admin-test-notification-db-smoke.mjs`

**Interfaces:**
- Consumes: prepared notification object from `prepareTestNotification()`
- Produces: `WorkflowRepository.queueTestNotification({ actor, notification, idempotencyKey })`
- Produces: `WorkflowRepository.getTestNotificationStatus({ actor, notificationId })`
- Produces: redacted status `{ id, channel, destination, subject, status, attempts, createdAt, sentAt, providerMessageId, lastError }`

- [ ] **Step 1: Add a failing database smoke for persistence and dispatch**

Create `scripts/admin-test-notification-db-smoke.mjs` with this setup before the assertions:

```js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { dispatchNotificationsJob } from '../src/automation/jobs.mjs';
import { prepareTestNotification } from '../src/workflow/test_notifications.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const encryptionKey = process.env.ENCRYPTION_KEY || 'e'.repeat(40);
const auditHmacKey = process.env.AUDIT_HMAC_KEY || 'a'.repeat(40);
const suffix = crypto.randomUUID();
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { encryptionKey, auditHmacKey });

async function systemAdmin(label) {
  let actor = await repository.upsertActorFromClaims({ subject:`admin-test-${label}-${suffix}`, email:`${label}-${suffix}@example.ca` });
  await pool.query("INSERT INTO user_global_roles (user_id,role) VALUES ($1,'system_admin') ON CONFLICT DO NOTHING", [actor.id]);
  return repository.upsertActorFromClaims({ subject:`admin-test-${label}-${suffix}` });
}

const admin = await systemAdmin('primary');
const otherAdmin = await systemAdmin('other');
const prepared = prepareTestNotification({
  channel:'email', destination:'jordanlegare4@gmail.com', subject:'Provider smoke', message:'Synthetic database smoke.',
  confirmation:'SEND TEST EMAIL TO jordanlegare4@gmail.com'
});

try {
  // assertions below
} finally {
  await pool.end();
}
```

The core assertions must be:

```js
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
assert.equal(raw.payload.requestDigest, prepared.requestDigest);

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
  config: { notificationProvider:'disabled', emailProvider:'test', notificationBatchSize:25, encryptionKey },
  repository,
  provider: { async send(message) { delivered.push(message); return { providerMessageId:'email_test_1' }; } }
});
assert.equal(dispatch.sent, 1);
assert.equal(delivered[0].to, prepared.destination);

const sent = await repository.getTestNotificationStatus({ actor: admin, notificationId: queued.id });
assert.equal(sent.status, 'sent');
assert.equal(sent.providerMessageId, 'email_test_1');
assert.equal(sent.destination, prepared.maskedDestination);
```

Continue the smoke with these concrete rate-limit, retry, and audit assertions:

```js
for (let index = 1; index <= 4; index += 1) {
  await repository.queueTestNotification({ actor:admin, notification:prepared, idempotencyKey:`admin-rate-${suffix}-${index}` });
}
await assert.rejects(
  repository.queueTestNotification({ actor:admin, notification:prepared, idempotencyKey:`admin-rate-${suffix}-6` }),
  /five test notifications per hour/i
);

await dispatchNotificationsJob({
  config:{ notificationProvider:'disabled', emailProvider:'test', notificationBatchSize:25, encryptionKey },
  repository,
  provider:{ async send() { return { providerMessageId:'rate-flush' }; } }
});

const failing = await repository.queueTestNotification({
  actor:otherAdmin,
  notification:prepared,
  idempotencyKey:`admin-failure-${suffix}`
});
for (const expected of [
  { attempts:1, status:'queued' },
  { attempts:2, status:'queued' },
  { attempts:3, status:'failed' }
]) {
  await dispatchNotificationsJob({
    config:{ notificationProvider:'disabled', emailProvider:'test', notificationBatchSize:1, encryptionKey },
    repository,
    provider:{ async send() { throw new Error(`synthetic failure for ${prepared.destination} ${'x'.repeat(1200)}`); } }
  });
  const state = await repository.getTestNotificationStatus({ actor:otherAdmin, notificationId:failing.id });
  assert.equal(state.attempts, expected.attempts);
  assert.equal(state.status, expected.status);
  assert.ok(state.lastError.length <= 1000);
  assert.doesNotMatch(state.lastError, /jordanlegare4@gmail\.com/);
}

const audit = await pool.query(
  "SELECT action FROM audit_log WHERE resource_type='notification' AND resource_id=$1 ORDER BY sequence",
  [queued.id]
);
assert.ok(audit.rows.some(row => row.action === 'notification.test_queued'));
console.log(JSON.stringify({ queued:true, sent:true, rateLimited:true, retried:true, failed:true, auditRecorded:true }));
```

- [ ] **Step 2: Run migrations through 015 and confirm the smoke fails**

Run against a disposable PostgreSQL database:

```bash
for migration in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"; done
node scripts/admin-test-notification-db-smoke.mjs
```

Expected before implementation: FAIL because `queueTestNotification` is undefined and migration 016 is absent.

- [ ] **Step 3: Add migration 016**

Create `db/migrations/016_admin_test_notifications.sql`:

```sql
BEGIN;

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS notification_outbox_admin_test_rate_idx
  ON notification_outbox(created_by, created_at DESC)
  WHERE template = 'admin_test';

COMMIT;
```

- [ ] **Step 4: Implement transactional repository methods**

In `src/db/workflow_repository.mjs`, import `decryptText` alongside `encryptText` and import `maskTestDestination` from `src/workflow/test_notifications.mjs`. Add this mapper to `WorkflowRepository`; never include `payload.message`, `payload.requestDigest`, raw `recipient`, `lock_token`, or `idempotency_key` in the returned object:

```js
redactTestNotification(row) {
  const destination = decryptText(row.recipient, this.encryptionKey);
  return {
    id: row.id,
    channel: row.channel,
    destination: maskTestDestination(row.channel, destination),
    subject: row.subject || '',
    status: row.status,
    attempts: Number(row.attempts || 0),
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    sentAt: row.sent_at?.toISOString?.() || row.sent_at || null,
    providerMessageId: row.provider_message_id || null,
    lastError: row.last_error || null
  };
}
```

Implement `queueTestNotification` with these exact transaction rules:

```js
async queueTestNotification({ actor, notification, idempotencyKey }) {
  return withTransaction(this.pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`admin-test:${actor.id}`]);
    const storedKey = `admin-test:${actor.id}:${idempotencyKey}`;
    const existing = (await client.query(
      "SELECT * FROM notification_outbox WHERE template='admin_test' AND idempotency_key=$1",
      [storedKey]
    )).rows[0];
    if (existing) {
      if (existing.payload?.requestDigest !== notification.requestDigest) {
        throw new Error('Idempotency key was already used for different test notification semantics.');
      }
      return this.redactTestNotification(existing);
    }
    const recent = Number((await client.query(
      "SELECT count(*) AS n FROM notification_outbox WHERE template='admin_test' AND created_by=$1 AND created_at > now()-interval '1 hour'",
      [actor.id]
    )).rows[0].n);
    if (recent >= 5) throw new Error('An administrator may queue at most five test notifications per hour.');
    const encrypted = encryptText(notification.destination, this.encryptionKey);
    const row = (await client.query(`
      INSERT INTO notification_outbox
        (grant_id,channel,recipient,template,payload,subject,idempotency_key,created_by)
      VALUES (NULL,$1,$2,'admin_test',$3::jsonb,$4,$5,$6)
      RETURNING *
    `, [notification.channel, encrypted, JSON.stringify({
      message: notification.message,
      requestDigest: notification.requestDigest
    }), notification.subject || null, storedKey, actor.id])).rows[0];
    await this.#appendAudit(client, {
      actor,
      organizationId: null,
      action: 'notification.test_queued',
      resourceType: 'notification',
      resourceId: row.id,
      requestId: storedKey,
      payload: { channel: notification.channel, template: 'admin_test' }
    });
    return this.redactTestNotification(row);
  });
}
```

Implement `getTestNotificationStatus` as a creator-scoped query:

```sql
SELECT * FROM notification_outbox
WHERE id=$1 AND template='admin_test' AND created_by=$2
```

Throw `Test notification not found.` if there is no row.

Update `markNotificationSent` to set `last_error=NULL`. Update `markNotificationFailed` to set `last_error=$3` with `String(errorMessage).slice(0,1000)` while preserving the existing retry status and audit behavior. Do not store provider errors in `payload`.

In `src/automation/jobs.mjs`, keep the decrypted destination in a `let destination = null` declared before the `try`. Add:

```js
function redactedProviderError(error, destination) {
  let message = String(error?.message || error || 'Unknown provider error.');
  if (destination) message = message.split(destination).join('[redacted-destination]');
  return message.slice(0, 1000);
}
```

Pass `redactedProviderError(error, destination)` to `markNotificationFailed`. The repository and audit chain therefore receive only the bounded redacted message.

- [ ] **Step 5: Extend schema readiness for the required column**

In `src/db/schema_readiness.mjs`, after the required-table query, add:

```sql
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='notification_outbox' AND column_name='created_by'
) AS present
```

Return `notification_outbox.created_by` in `missing` when absent. Update `expectedObjects` so it includes this required column contract.

- [ ] **Step 6: Run database smoke and existing database scripts**

Run:

```bash
node scripts/admin-test-notification-db-smoke.mjs
npm run schema:check
npm run test:db
npm run test:portal-db
```

Expected: all commands exit 0; the new smoke prints JSON with `queued`, `sent`, `rateLimited`, `retried`, `failed`, and `auditRecorded` set true.

- [ ] **Step 7: Commit persistence**

```bash
git add db/migrations/016_admin_test_notifications.sql src/db/workflow_repository.mjs src/db/schema_readiness.mjs src/automation/jobs.mjs scripts/admin-test-notification-db-smoke.mjs
git commit -m "Add audited admin test notification outbox"
```

---

### Task 3: System-Admin Service and Authenticated MCP Tools

**Files:**
- Modify: `src/workflow/workflow_service.mjs`
- Modify: `src/mcp/workflow_tools.mjs`
- Modify: `test/test_notifications.test.mjs`
- Modify: `test/workflow_tools.test.mjs`

**Interfaces:**
- Consumes: `prepareTestNotification(args)`
- Consumes: repository methods from Task 2
- Produces: `WorkflowService.queueTestNotification(actor, args)`
- Produces: `WorkflowService.getTestNotificationStatus(actor, notificationId)`
- Produces MCP tools: `queue_test_notification`, `get_test_notification_status`

- [ ] **Step 1: Write failing service authorization and provider tests**

Append to `test/test_notifications.test.mjs`:

```js
import { WorkflowService } from '../src/workflow/workflow_service.mjs';

function serviceFixture(config = {}) {
  const calls = [];
  const repository = {
    queueTestNotification(args) { calls.push(args); return { id:'00000000-0000-4000-8000-000000000001', status:'queued' }; },
    getTestNotificationStatus(args) { calls.push(args); return { id:args.notificationId, status:'sent' }; }
  };
  return {
    calls,
    service: new WorkflowService({ repository, t3010Repository:null, config:{
      notificationProvider:'disabled', emailProvider:'disabled', ...config
    } })
  };
}

test('only a global system administrator can queue or inspect a test notification', async () => {
  const { service } = serviceFixture({ emailProvider:'resend' });
  const nonAdmin = { id:'user-1', roles:[], memberships:[{ organizationId:'org-1', role:'recipient_admin' }] };
  await assert.rejects(service.queueTestNotification(nonAdmin, {
    channel:'email', destination:'test@example.ca', subject:'', message:'test',
    confirmation:'SEND TEST EMAIL TO test@example.ca', idempotencyKey:'test-key-1'
  }), /lacks global role system_admin/);
  await assert.rejects(service.getTestNotificationStatus(nonAdmin, '00000000-0000-4000-8000-000000000001'), /lacks global role system_admin/);
});

test('service rejects disabled channel providers before persistence', async () => {
  const admin = { id:'admin-1', roles:['system_admin'], memberships:[] };
  const { service, calls } = serviceFixture();
  await assert.rejects(service.queueTestNotification(admin, {
    channel:'email', destination:'test@example.ca', subject:'', message:'test',
    confirmation:'SEND TEST EMAIL TO test@example.ca', idempotencyKey:'test-key-2'
  }), /EMAIL_PROVIDER is disabled/);
  assert.equal(calls.length, 0);
});
```

Add this successful provider matrix to the same file:

```js
test('system administrator can queue email, SMS and voice tests when each provider is enabled', async () => {
  const admin = { id:'admin-1', roles:['system_admin'], memberships:[] };
  const cases = [
    {
      config:{ emailProvider:'resend' },
      args:{ channel:'email', destination:'test@example.ca', subject:'Smoke', message:'email', confirmation:'SEND TEST EMAIL TO test@example.ca', idempotencyKey:'email-key-1' }
    },
    {
      config:{ notificationProvider:'twilio' },
      args:{ channel:'sms', destination:'+14165550123', subject:'', message:'sms', confirmation:'SEND TEST SMS TO +14165550123', idempotencyKey:'sms-key-1' }
    },
    {
      config:{ notificationProvider:'twilio' },
      args:{ channel:'voice', destination:'+14165550123', subject:'', message:'voice', confirmation:'SEND TEST VOICE TO +14165550123', idempotencyKey:'voice-key-1' }
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
```

- [ ] **Step 2: Update the MCP surface test first**

In `test/workflow_tools.test.mjs`, add both names to the required tool list, then assert:

```js
assert.equal(tools.get('queue_test_notification').spec.annotations.destructiveHint, true);
assert.equal(tools.get('queue_test_notification').spec.annotations.readOnlyHint, false);
assert.equal(tools.get('get_test_notification_status').spec.annotations.readOnlyHint, true);
assert.equal(tools.get('get_test_notification_status').spec.annotations.destructiveHint, false);
```

Run:

```bash
node --test test/test_notifications.test.mjs test/workflow_tools.test.mjs
```

Expected: FAIL because the service methods and tools do not exist.

- [ ] **Step 3: Implement WorkflowService methods**

In `src/workflow/workflow_service.mjs`, import `prepareTestNotification`. Add:

```js
async queueTestNotification(actor, args) {
  requireGlobalRole(actor, ROLES.SYSTEM_ADMIN);
  if (args.channel === 'email' && (!this.config.emailProvider || this.config.emailProvider === 'disabled')) {
    throw new Error('EMAIL_PROVIDER is disabled; email test notifications are unavailable.');
  }
  if (['sms','voice'].includes(args.channel) && (!this.config.notificationProvider || this.config.notificationProvider === 'disabled')) {
    throw new Error('NOTIFICATION_PROVIDER is disabled; phone test notifications are unavailable.');
  }
  const notification = prepareTestNotification(args);
  return this.repository.queueTestNotification({ actor, notification, idempotencyKey: args.idempotencyKey });
}

getTestNotificationStatus(actor, notificationId) {
  requireGlobalRole(actor, ROLES.SYSTEM_ADMIN);
  return this.repository.getTestNotificationStatus({ actor, notificationId });
}
```

- [ ] **Step 4: Register the MCP tools**

In `src/mcp/workflow_tools.mjs`, register:

```js
server.registerTool('queue_test_notification', {
  title: 'Queue provider delivery test',
  description: 'System-admin action to queue one external email, SMS, or voice delivery test through the encrypted outbox and autonomous worker. This sends a real test message and does not create a grant.',
  inputSchema: {
    channel: z.enum(['email','sms','voice']),
    destination: z.string().min(3).max(254),
    subject: z.string().max(120).default(''),
    message: z.string().min(1).max(500),
    confirmation: z.string().min(1).max(500),
    idempotencyKey
  },
  annotations: consequential
}, async args => result('Queued the external delivery test. Poll its status before treating provider acceptance as successful.', {
  notification: await service.queueTestNotification(actor, args)
}));

server.registerTool('get_test_notification_status', {
  title: 'Get provider delivery test status',
  description: 'System-admin read of one redacted delivery test, including attempts, provider acceptance identifier and bounded failure information.',
  inputSchema: { notificationId: uuid },
  annotations: readOnly
}, async ({ notificationId }) => result('Returned redacted delivery-test status.', {
  notification: await service.getTestNotificationStatus(actor, notificationId)
}));
```

- [ ] **Step 5: Run focused and full tests**

```bash
node --test test/test_notifications.test.mjs test/workflow_tools.test.mjs
node --test test/*.test.mjs
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit service and MCP surface**

```bash
git add src/workflow/workflow_service.mjs src/mcp/workflow_tools.mjs test/test_notifications.test.mjs test/workflow_tools.test.mjs
git commit -m "Expose system admin delivery test tools"
```

---

### Task 4: Email-Only Worker and Scheduler Correction

**Files:**
- Modify: `src/automation/scheduler.mjs`
- Modify: `scripts/autonomous-worker.mjs`
- Modify: `scripts/dispatch-notifications.mjs`
- Modify: `test/automation.test.mjs`

**Interfaces:**
- Produces: `notificationsConfigured(config): boolean` local helper or equivalent expression used consistently in all three runtime entry points.
- Preserves: `createNotificationProvider(config).send({ channel, to, body, subject, idempotencyKey })`.

- [ ] **Step 1: Add a failing provider enablement matrix**

Append to `test/automation.test.mjs`:

```js
test('email-only delivery enables offer batches and notification dispatch', () => {
  const jobs = jobDefinitions({
    automationEnabled:true,
    enableWorkflowWrites:true,
    recipientPortalEnabled:true,
    notificationProvider:'disabled',
    emailProvider:'resend',
    notificationPollSeconds:30,
    automatedPortfoliosEnabled:false,
    allocationPolicyPollSeconds:300,
    enableT3010Sync:false,
    t3010SyncIntervalHours:24
  });
  const byName = Object.fromEntries(jobs.map(job => [job.name, job]));
  assert.equal(byName.notifications.enabled, true);
  assert.equal(byName.offer_batches.enabled, true);
});

test('delivery jobs remain disabled only when both provider families are disabled', () => {
  const jobs = jobDefinitions({
    automationEnabled:true,
    enableWorkflowWrites:true,
    recipientPortalEnabled:true,
    notificationProvider:'disabled',
    emailProvider:'disabled',
    notificationPollSeconds:30,
    automatedPortfoliosEnabled:false,
    allocationPolicyPollSeconds:300,
    enableT3010Sync:false,
    t3010SyncIntervalHours:24
  });
  const byName = Object.fromEntries(jobs.map(job => [job.name, job]));
  assert.equal(byName.notifications.enabled, false);
  assert.equal(byName.offer_batches.enabled, false);
});
```

- [ ] **Step 2: Run the automation test and confirm the email-only failure**

```bash
node --test test/automation.test.mjs
```

Expected: FAIL because `notifications` and `offer_batches` are false for email-only configuration.

- [ ] **Step 3: Correct all runtime gates**

Use the same predicate everywhere:

```js
const notificationsConfigured = config.notificationProvider !== 'disabled' || config.emailProvider !== 'disabled';
```

In `src/automation/scheduler.mjs`, use it for `offer_batches` and `notifications`.

In `scripts/autonomous-worker.mjs`, replace the phone-only provider construction with:

```js
const notificationsConfigured = config.notificationProvider !== 'disabled' || config.emailProvider !== 'disabled';
const provider = notificationsConfigured ? createNotificationProvider(config) : null;
```

In `scripts/dispatch-notifications.mjs`, reject only when both providers are disabled, and change the error to `All notification providers are disabled.`

- [ ] **Step 4: Run automation, email, and full unit tests**

```bash
node --test test/automation.test.mjs test/verified_email.test.mjs test/test_notifications.test.mjs
node --test test/*.test.mjs
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit the runtime correction**

```bash
git add src/automation/scheduler.mjs scripts/autonomous-worker.mjs scripts/dispatch-notifications.mjs test/automation.test.mjs
git commit -m "Enable autonomous email-only delivery"
```

---

### Task 5: CI, Documentation, and Full Verification

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/verified-contact-offers.yml`
- Modify: `README.md`

**Interfaces:**
- Produces npm script: `test:admin-notification-db`
- Documents MCP tools: `queue_test_notification`, `get_test_notification_status`

- [ ] **Step 1: Add the script and syntax coverage**

In `package.json`, add:

```json
"test:admin-notification-db": "node scripts/admin-test-notification-db-smoke.mjs"
```

Add these files to the existing `check` command:

```text
node --check src/workflow/test_notifications.mjs
node --check scripts/admin-test-notification-db-smoke.mjs
```

- [ ] **Step 2: Add CI database coverage**

In `.github/workflows/ci.yml`, immediately after the database schema readiness gate, add:

```yaml
- name: Admin provider-delivery test database smoke
  env: *db-env
  run: npm run test:admin-notification-db
```

In `.github/workflows/verified-contact-offers.yml`, add the two new files to the syntax-check step. Do not duplicate the database smoke in that workflow.

- [ ] **Step 3: Document the tools and operational meaning**

In `README.md`, add an `Admin provider delivery tests` subsection under email/SMS/voice delivery. Document:

```text
queue_test_notification
get_test_notification_status
```

State all of these facts explicitly:

- global `system_admin` is required;
- confirmation includes normalized destination;
- the destination is encrypted and redacted;
- the fixed prefix identifies the message as a test;
- five new tests per administrator per hour;
- email requires `EMAIL_PROVIDER`; SMS/voice require `NOTIFICATION_PROVIDER`;
- provider `sent` status means provider acceptance, not inbox placement or human receipt;
- the test traverses the normal worker and may remain `queued` until the next poll.

Add migration 016 and the admin notification DB smoke to the migration/testing summaries.

- [ ] **Step 4: Run fresh local verification**

Run:

```bash
npm run check
npm test
npm run readiness
git diff --check
git status --short
```

With PostgreSQL available and all migrations applied, also run:

```bash
npm run schema:check
npm run test:admin-notification-db
npm run test:db
npm run test:portal-db
npm run test:verified-email-db
npm run ops:once
```

Expected: every command exits 0. `git status --short` lists only the intended Task 5 files before the commit.

- [ ] **Step 5: Review security invariants manually**

Run:

```bash
rg -n "queue_test_notification|get_test_notification_status|admin_test|created_by" src scripts db test README.md
rg -n "recipient|destination|confirmation" src/workflow/test_notifications.mjs src/db/workflow_repository.mjs src/mcp/workflow_tools.mjs
```

Confirm from the matched lines that raw destinations occur only in MCP input, transient normalization, encryption, and provider invocation; audit and returned structures contain only channel, template, digest, IDs, and masks.

- [ ] **Step 6: Commit CI and documentation**

```bash
git add package.json .github/workflows/ci.yml .github/workflows/verified-contact-offers.yml README.md
git commit -m "Validate admin provider delivery tests"
```

- [ ] **Step 7: Verify the complete branch after all commits**

```bash
git status --short --branch
git log --oneline --decorate -7
npm run check
npm test
```

Expected: clean working tree, the five feature commits follow the design/plan commits, syntax passes, and all unit tests report zero failures.

After deployment, invoke `queue_test_notification` with:

```json
{
  "channel": "email",
  "destination": "jordanlegare4@gmail.com",
  "subject": "Clearing House provider test",
  "message": "This message verifies the configured email delivery path.",
  "confirmation": "SEND TEST EMAIL TO jordanlegare4@gmail.com",
  "idempotencyKey": "live-email-provider-test-2026-08-17"
}
```

Poll the returned ID with `get_test_notification_status`. Treat `sent` as provider acceptance only.
