import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { ensureOfferAccess, inspectOfferAccess, consumeOfferAccess, OfferAccessError } from '../src/workflow/offer_access.mjs';
import { encryptText } from '../src/security/crypto.mjs';
import { dispatchNotificationsJob } from '../src/automation/jobs.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const encryptionKey = process.env.ENCRYPTION_KEY || 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const auditHmacKey = process.env.AUDIT_HMAC_KEY || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { encryptionKey, auditHmacKey });

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function makeOfferedGrant(label) {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const foundation = (await pool.query(`
    INSERT INTO organizations (business_number, legal_name, organization_type)
    VALUES ($1,$2,'foundation') RETURNING id, legal_name
  `, [`F${suffix}`, `Foundation ${label}`])).rows[0];
  const recipient = (await pool.query(`
    INSERT INTO organizations (business_number, legal_name, organization_type)
    VALUES ($1,$2,'registered_charity') RETURNING id, legal_name, business_number
  `, [`R${suffix}`, `Recipient ${label}`])).rows[0];
  const termsText = `Funding terms for ${label}: unrestricted charitable operating support.`;
  const grant = (await pool.query(`
    INSERT INTO grants
      (foundation_org_id, recipient_org_id, amount_cad, purpose, recipient_type, state,
       terms_version, terms_digest, terms_text, offered_at, creation_idempotency_key)
    VALUES ($1,$2,42500.00,'General operating support','qualified_donee','offered',$3,$4,$5,now(),$6)
    RETURNING id
  `, [foundation.id, recipient.id, `terms-${label}`, digest(termsText), termsText, `portal-smoke-${label}-${suffix}`])).rows[0];
  return { grantId: grant.id, foundation, recipient, termsText };
}

try {
  const accepted = await makeOfferedGrant('accept');
  const first = await ensureOfferAccess({
    repository,
    grantId: accepted.grantId,
    portalBaseUrl: 'https://offers.example.ca',
    ttlHours: 24,
    requestId: 'portal-smoke:issue-accept'
  });
  assert.match(first.url, /^https:\/\/offers\.example\.ca\/offer\/[A-Za-z0-9_-]{40,128}$/);
  assert.equal(first.reused, false);

  const replay = await ensureOfferAccess({
    repository,
    grantId: accepted.grantId,
    portalBaseUrl: 'https://offers.example.ca',
    ttlHours: 24,
    requestId: 'portal-smoke:issue-accept-retry'
  });
  assert.equal(replay.url, first.url);
  assert.equal(replay.reused, true);

  const stored = (await pool.query('SELECT token_hash, token_secret_encrypted FROM offer_access_tokens WHERE id=$1', [first.tokenId])).rows[0];
  assert.notEqual(stored.token_hash, first.token);
  assert.ok(stored.token_secret_encrypted);
  assert.equal(stored.token_secret_encrypted.includes(first.token), false);

  const visible = await inspectOfferAccess(repository, first.token);
  assert.equal(visible.grantId, accepted.grantId);
  assert.equal(visible.amountCad, 42500);
  assert.equal(visible.recipient.name, accepted.recipient.legal_name);

  const acceptedResult = await consumeOfferAccess(repository, first.token, 'accept');
  assert.equal(acceptedResult.state, 'accepted');
  const acceptedGrant = (await pool.query('SELECT state, accepted_by FROM grants WHERE id=$1', [accepted.grantId])).rows[0];
  assert.equal(acceptedGrant.state, 'accepted');
  assert.equal(acceptedGrant.accepted_by, null);
  const consent = (await pool.query('SELECT accepted, acceptance_method, offer_token_id FROM recipient_consents WHERE grant_id=$1 ORDER BY accepted_at DESC LIMIT 1', [accepted.grantId])).rows[0];
  assert.equal(consent.accepted, true);
  assert.equal(consent.acceptance_method, 'offer_token');
  assert.equal(consent.offer_token_id, first.tokenId);
  await assert.rejects(() => inspectOfferAccess(repository, first.token), OfferAccessError);

  const declined = await makeOfferedGrant('decline');
  const declineAccess = await ensureOfferAccess({
    repository,
    grantId: declined.grantId,
    portalBaseUrl: 'https://offers.example.ca',
    ttlHours: 24,
    requestId: 'portal-smoke:issue-decline'
  });
  const declineResult = await consumeOfferAccess(repository, declineAccess.token, 'decline');
  assert.equal(declineResult.state, 'declined');
  const declineConsent = (await pool.query('SELECT accepted, acceptance_method FROM recipient_consents WHERE grant_id=$1 ORDER BY accepted_at DESC LIMIT 1', [declined.grantId])).rows[0];
  assert.equal(declineConsent.accepted, false);
  assert.equal(declineConsent.acceptance_method, 'offer_token');

  const changed = await makeOfferedGrant('terms-change');
  const changedAccess = await ensureOfferAccess({
    repository,
    grantId: changed.grantId,
    portalBaseUrl: 'https://offers.example.ca',
    ttlHours: 24,
    requestId: 'portal-smoke:issue-change'
  });
  await pool.query("UPDATE grants SET terms_digest='replacement-digest' WHERE id=$1", [changed.grantId]);
  await assert.rejects(() => inspectOfferAccess(repository, changedAccess.token), OfferAccessError);

  // Prove the autonomous notification path inserts the secure offer URL immediately
  // before delivery instead of relying on a human or a prior browser session.
  await pool.query("DELETE FROM notification_outbox WHERE status='queued'");
  const notified = await makeOfferedGrant('notification');
  const encryptedRecipient = encryptText('+15145550123', encryptionKey);
  await pool.query(`
    INSERT INTO notification_outbox
      (grant_id, channel, recipient, template, payload, status, idempotency_key)
    VALUES ($1,'sms',$2,'grant_offer',$3::jsonb,'queued',$4)
  `, [notified.grantId, encryptedRecipient, JSON.stringify({ message: 'legacy sign-in message' }), `portal-smoke-notification-${notified.grantId}`]);
  const deliveredMessages = [];
  const notificationResult = await dispatchNotificationsJob({
    config: {
      notificationProvider: 'test',
      notificationBatchSize: 10,
      encryptionKey,
      recipientPortalEnabled: true,
      recipientPortalBaseUrl: 'https://offers.example.ca',
      offerTokenTtlHours: 24
    },
    repository,
    provider: { async send(message) { deliveredMessages.push(message); return { providerMessageId: 'test-message-1' }; } }
  });
  assert.equal(notificationResult.sent, 1);
  assert.equal(notificationResult.secureOfferLinks, 1);
  assert.equal(deliveredMessages.length, 1);
  assert.match(deliveredMessages[0].body, /No grant application is required/);
  assert.match(deliveredMessages[0].body, /https:\/\/offers\.example\.ca\/offer\/[A-Za-z0-9_-]{40,128}/);
  assert.equal(deliveredMessages[0].body.includes('legacy sign-in message'), false);

  const audit = await pool.query("SELECT action FROM audit_log WHERE resource_id=$1 ORDER BY sequence", [accepted.grantId]);
  assert.ok(audit.rows.some(row => row.action === 'grant.accepted_by_offer_token'));
  console.log(JSON.stringify({
    ok: true,
    acceptedGrant: accepted.grantId,
    declinedGrant: declined.grantId,
    notificationGrant: notified.grantId,
    singleUse: true,
    encryptedSecret: true,
    autonomousOfferLinkDelivery: true
  }, null, 2));
} finally {
  await pool.end();
}
