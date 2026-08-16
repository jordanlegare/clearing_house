import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { WorkflowService } from '../src/workflow/workflow_service.mjs';
import { createAllocationPolicy } from '../src/automation/allocation_policies.mjs';
import { reviewBundleHash } from '../src/workflow/review_bundles.mjs';
import { createOfferBatch, getOfferBatch, runOneOfferBatch } from '../src/workflow/offer_batches.mjs';
import { dispatchNotificationsJob } from '../src/automation/jobs.mjs';
import { decryptText } from '../src/security/crypto.mjs';
import { verifyContactChallenge } from '../src/workflow/recipient_contacts.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const encryptionKey = process.env.ENCRYPTION_KEY || 'e'.repeat(40);
const auditHmacKey = process.env.AUDIT_HMAC_KEY || 'a'.repeat(40);
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { encryptionKey, auditHmacKey });
const config = {
  enableWorkflowWrites: true,
  recipientPortalEnabled: true,
  recipientPortalBaseUrl: 'https://offers.example.ca',
  offerTokenTtlHours: 168,
  notificationProvider: 'test',
  notificationBatchSize: 25,
  encryptionKey,
  paymentProvider: 'manual',
  requireSeparationOfDuties: true,
  craStatusMaxAgeHours: 24,
  allocationPolicyBatchSize: 10
};

function date(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

try {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const foundationBn = '965432198RR0001';
  const recipientBn = '765432198RR0001';
  const foundation = (await pool.query(`INSERT INTO organizations (business_number,legal_name,organization_type)
    VALUES ($1,$2,'foundation') RETURNING *`, [foundationBn, `Contact Foundation ${suffix}`])).rows[0];
  const recipient = (await pool.query(`INSERT INTO organizations (business_number,legal_name,organization_type)
    VALUES ($1,$2,'registered_charity') RETURNING *`, [recipientBn, `Contact Recipient ${suffix}`])).rows[0];

  let analyst = await repository.upsertActorFromClaims({ subject:`contact-analyst-${suffix}`, email:`analyst-${suffix}@example.ca` });
  let approver = await repository.upsertActorFromClaims({ subject:`contact-approver-${suffix}`, email:`approver-${suffix}@example.ca` });
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_analyst') ON CONFLICT DO NOTHING`, [analyst.id, foundation.id]);
  await pool.query(`INSERT INTO memberships (user_id,organization_id,role) VALUES ($1,$2,'foundation_approver') ON CONFLICT DO NOTHING`, [approver.id, foundation.id]);
  analyst = await repository.upsertActorFromClaims({ subject:`contact-analyst-${suffix}` });
  approver = await repository.upsertActorFromClaims({ subject:`contact-approver-${suffix}` });

  const policy = await createAllocationPolicy(repository, analyst, {
    foundationOrgId: foundation.id,
    title: `Contact delivery ${suffix}`,
    targetBudgetCad: 25000,
    minGrantCad: 5000,
    maxGrantCad: 25000,
    maxRecipients: 1,
    minimumScore: 0,
    purpose: 'General operating support',
    windowStart: date(-1),
    windowEnd: date(30),
    refreshIntervalSeconds: 3600,
    autoMaterializeDrafts: true,
    idempotencyKey: `contact-policy-${suffix}`
  });

  const grant = (await pool.query(`INSERT INTO grants
    (foundation_org_id,recipient_org_id,amount_cad,purpose,recipient_type,state,automation_policy_id,proposed_by,approved_by,creation_idempotency_key)
    VALUES ($1,$2,25000,'General operating support','qualified_donee','approved',$3,$4,$5,$6)
    RETURNING *`, [foundation.id, recipient.id, policy.id, analyst.id, approver.id, `contact-grant-${suffix}`])).rows[0];
  const bundleItems = [{ grantId: grant.id, recipientOrgId: recipient.id, amountCad: 25000 }];
  const bundleHash = reviewBundleHash({ foundationOrgId: foundation.id, policyId: policy.id, policyVersion: policy.version, items: bundleItems });
  const bundle = (await pool.query(`INSERT INTO grant_review_bundles
    (policy_id,foundation_org_id,policy_version,status,bundle_hash,grant_count,total_cad,created_by,approved_by,approved_at)
    VALUES ($1,$2,$3,'approved',$4,1,25000,$5,$6,now()) RETURNING *`,
  [policy.id, foundation.id, policy.version, bundleHash, analyst.id, approver.id])).rows[0];
  await pool.query(`INSERT INTO grant_review_bundle_items (bundle_id,grant_id,recipient_org_id,amount_cad,position)
    VALUES ($1,$2,$3,25000,1)`, [bundle.id, grant.id, recipient.id]);

  const service = new WorkflowService({ repository, t3010Repository: null, config });
  const batch = await createOfferBatch(service, approver, {
    reviewBundleId: bundle.id,
    termsVersion: '2026-standard-1',
    termsText: 'General operating support. By accepting, the recipient confirms authority to accept these funding terms.',
    preferredChannel: 'sms',
    idempotencyKey: `contact-offer-batch-${suffix}`
  });
  assert.equal(batch.status, 'pending_contacts');

  const fakeT3010 = {
    loaded: true,
    charityProfile(bn) {
      if (bn !== recipientBn) return null;
      return {
        bn,
        name: recipient.legal_name,
        sourceYear: 2024,
        publicContactCandidates: [
          { channel:'sms', destination:'+15145550123', sourceKey:'telephone', sourceValue:'514-555-0123' },
          { channel:'voice', destination:'+15145550123', sourceKey:'telephone', sourceValue:'514-555-0123' }
        ]
      };
    }
  };

  const firstRun = await runOneOfferBatch({ config, repository, batchId: batch.id, t3010Repository: fakeT3010 });
  assert.equal(firstRun.pending, 1);
  assert.equal(firstRun.offered, 0);
  const contact = (await pool.query(`SELECT * FROM recipient_contacts WHERE organization_id=$1 AND channel='sms'`, [recipient.id])).rows[0];
  assert.equal(contact.status, 'verification_pending');
  assert.ok(contact.destination_encrypted);
  assert.equal(contact.destination_encrypted.includes('5145550123'), false);

  const verificationMessages = [];
  const dispatchVerification = await dispatchNotificationsJob({
    config,
    repository,
    provider: { async send(message) { verificationMessages.push(message); return { providerMessageId:'verify-message-1' }; } }
  });
  assert.equal(dispatchVerification.contactVerificationLinks, 1);
  assert.match(verificationMessages[0].body, /Verify this public contact channel/);
  assert.match(verificationMessages[0].body, /https:\/\/offers\.example\.ca\/verify-contact\//);

  const challenge = (await pool.query(`SELECT * FROM recipient_contact_challenges WHERE contact_id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [contact.id])).rows[0];
  const rawToken = decryptText(challenge.token_secret_encrypted, encryptionKey);
  const verified = await verifyContactChallenge(repository, rawToken);
  assert.equal(verified.verified, true);
  assert.equal((await pool.query('SELECT status FROM recipient_contacts WHERE id=$1', [contact.id])).rows[0].status, 'verified');

  const secondRun = await runOneOfferBatch({ config, repository, batchId: batch.id, t3010Repository: fakeT3010 });
  assert.equal(secondRun.offered, 1);
  assert.equal(secondRun.pending, 0);
  assert.equal(secondRun.status, 'offered');
  const offeredGrant = (await pool.query('SELECT state,terms_version FROM grants WHERE id=$1', [grant.id])).rows[0];
  assert.equal(offeredGrant.state, 'offered');
  assert.equal(offeredGrant.terms_version, '2026-standard-1');

  const offerMessages = [];
  const dispatchOffer = await dispatchNotificationsJob({
    config,
    repository,
    provider: { async send(message) { offerMessages.push(message); return { providerMessageId:'offer-message-1' }; } }
  });
  assert.equal(dispatchOffer.secureOfferLinks, 1);
  assert.match(offerMessages[0].body, /No grant application is required/);
  assert.match(offerMessages[0].body, /https:\/\/offers\.example\.ca\/offer\//);

  const finalBatch = await getOfferBatch(repository, approver, { batchId: batch.id });
  assert.equal(finalBatch.status, 'offered');
  assert.equal(finalBatch.items[0].status, 'offered');
  assert.equal(finalBatch.items[0].contactId, contact.id);

  console.log(JSON.stringify({
    ok: true,
    batchId: batch.id,
    contactCandidateSeeded: true,
    publicContactEncrypted: true,
    channelControlVerified: true,
    grantOfferedAutomaticallyAfterVerification: true,
    secureOfferLinkDelivered: true
  }, null, 2));
} finally {
  await pool.end();
}
