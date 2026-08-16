import crypto from 'node:crypto';
import { buildAuditEntry } from '../security/audit.mjs';
import { PERMISSIONS, requireOrgPermission } from '../security/rbac.mjs';
import { getReviewBundle } from './review_bundles.mjs';
import { findVerifiedRecipientContact, seedPublicRecipientContacts, ensureContactVerification } from './recipient_contacts.mjs';
import { seedWebsiteRecipientContacts } from '../integrations/website_contact.mjs';

function termsDigest(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

export function offerBatchHash({ reviewBundleId, reviewBundleHash, termsVersion, termsText, preferredChannel }) {
  const canonical = {
    reviewBundleId,
    reviewBundleHash,
    termsVersion: String(termsVersion),
    termsDigest: termsDigest(termsText),
    preferredChannel
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function appendAudit(repository, client, { actor, organizationId, action, resourceId, requestId, payload }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [742019301]);
  const previous = await client.query('SELECT entry_hmac FROM audit_log ORDER BY sequence DESC LIMIT 1');
  const occurredAt = new Date().toISOString();
  const entry = buildAuditEntry({
    key: repository.auditHmacKey,
    previousDigest: previous.rows[0]?.entry_hmac || '',
    occurredAt,
    actorUserId: actor?.id || '',
    organizationId,
    action,
    resourceType: 'grant_offer_batch',
    resourceId: String(resourceId),
    requestId: requestId || '',
    payload
  });
  await client.query(`INSERT INTO audit_log
    (occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,request_id,payload_digest,previous_digest,entry_hmac)
    VALUES ($1,$2,$3,$4,'grant_offer_batch',$5,$6,$7,$8,$9)`,
  [occurredAt, actor?.id || null, organizationId, action, String(resourceId), requestId || null,
    entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

async function loadOfferBatch(repository, batchId) {
  const batch = (await repository.pool.query('SELECT * FROM grant_offer_batches WHERE id=$1', [batchId])).rows[0];
  if (!batch) return null;
  const { rows } = await repository.pool.query(`
    SELECT i.*,g.state AS grant_state,g.terms_version AS grant_terms_version,g.terms_digest AS grant_terms_digest,
      o.legal_name AS recipient_name,o.business_number AS recipient_bn
    FROM grant_offer_batch_items i
    JOIN grants g ON g.id=i.grant_id
    JOIN organizations o ON o.id=i.recipient_org_id
    WHERE i.batch_id=$1 ORDER BY o.legal_name,i.grant_id
  `, [batchId]);
  return {
    id: batch.id,
    reviewBundleId: batch.review_bundle_id,
    foundationOrgId: batch.foundation_org_id,
    termsVersion: batch.terms_version,
    termsDigest: batch.terms_digest,
    termsText: batch.terms_text,
    preferredChannel: batch.preferred_channel,
    status: batch.status,
    batchHash: batch.batch_hash,
    createdBy: batch.created_by,
    createdAt: batch.created_at?.toISOString?.() || batch.created_at,
    completedAt: batch.completed_at?.toISOString?.() || batch.completed_at || null,
    items: rows.map(row => ({
      grantId: row.grant_id,
      recipientOrgId: row.recipient_org_id,
      recipientName: row.recipient_name,
      recipientBn: row.recipient_bn,
      contactId: row.contact_id,
      status: row.status,
      lastError: row.last_error,
      grantState: row.grant_state,
      grantTermsVersion: row.grant_terms_version,
      grantTermsDigest: row.grant_terms_digest
    }))
  };
}

export async function createOfferBatch(service, actor, {
  reviewBundleId,
  termsVersion,
  termsText,
  preferredChannel = 'sms',
  idempotencyKey
}) {
  if (!idempotencyKey) throw new Error('idempotencyKey is required.');
  const bundle = await getReviewBundle(service.repository, actor, { bundleId: reviewBundleId });
  requireOrgPermission(actor, bundle.foundationOrgId, PERMISSIONS.OFFER_GRANT);
  if (bundle.status !== 'approved') throw new Error('Review bundle must be approved before a recipient offer batch can be created.');
  if (!bundle.items.length || !bundle.items.every(item => item.state === 'approved')) throw new Error('Every grant in the review bundle must still be approved before offering.');
  if (!['sms','voice'].includes(preferredChannel)) throw new Error('preferredChannel must be sms or voice.');
  const version = String(termsVersion || '').trim();
  const text = String(termsText || '').trim();
  if (!version || text.length < 10) throw new Error('Versioned offer terms are required.');
  const digest = termsDigest(text);
  const hash = offerBatchHash({ reviewBundleId, reviewBundleHash: bundle.bundleHash, termsVersion: version, termsText: text, preferredChannel });

  const client = await service.repository.pool.connect();
  try {
    await client.query('BEGIN');
    const replay = (await client.query(`
      SELECT c.batch_id,b.* FROM grant_offer_batch_commands c JOIN grant_offer_batches b ON b.id=c.batch_id
      WHERE c.idempotency_key=$1
    `, [idempotencyKey])).rows[0];
    if (replay) {
      if (replay.review_bundle_id !== reviewBundleId || replay.batch_hash !== hash) throw new Error('idempotencyKey was already used for a different offer batch.');
      await client.query('COMMIT');
      return loadOfferBatch(service.repository, replay.batch_id);
    }
    const existing = (await client.query('SELECT * FROM grant_offer_batches WHERE review_bundle_id=$1 FOR UPDATE', [reviewBundleId])).rows[0];
    if (existing) {
      if (existing.batch_hash !== hash) throw new Error('This review bundle already has an offer batch with different terms or channel settings.');
      await client.query(`INSERT INTO grant_offer_batch_commands (idempotency_key,batch_id,command) VALUES ($1,$2,'create')`, [idempotencyKey, existing.id]);
      await client.query('COMMIT');
      return loadOfferBatch(service.repository, existing.id);
    }
    const batch = (await client.query(`
      INSERT INTO grant_offer_batches
        (review_bundle_id,foundation_org_id,terms_version,terms_digest,terms_text,preferred_channel,batch_hash,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [reviewBundleId, bundle.foundationOrgId, version, digest, text, preferredChannel, hash, actor.id])).rows[0];
    for (const item of bundle.items) {
      await client.query(`INSERT INTO grant_offer_batch_items (batch_id,grant_id,recipient_org_id) VALUES ($1,$2,$3)`, [batch.id, item.grantId, item.recipientOrgId]);
    }
    await client.query(`INSERT INTO grant_offer_batch_commands (idempotency_key,batch_id,command) VALUES ($1,$2,'create')`, [idempotencyKey, batch.id]);
    await appendAudit(service.repository, client, {
      actor,
      organizationId: bundle.foundationOrgId,
      action: 'grant_offer_batch.created',
      resourceId: batch.id,
      requestId: idempotencyKey,
      payload: { reviewBundleId, grantCount: bundle.items.length, termsVersion: version, termsDigest: digest, preferredChannel, batchHash: hash }
    });
    await client.query('COMMIT');
    return loadOfferBatch(service.repository, batch.id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function getOfferBatch(repository, actor, { batchId }) {
  const batch = await loadOfferBatch(repository, batchId);
  if (!batch) throw new Error('Offer batch not found.');
  requireOrgPermission(actor, batch.foundationOrgId, PERMISSIONS.READ_PRIVATE_ORG);
  return batch;
}

export async function listOfferBatches(repository, actor, { foundationOrgId = null, status = null, limit = 50 } = {}) {
  if (!actor?.id) throw new Error('Authentication is required.');
  let ids = [];
  const systemAdmin = (actor.roles || []).includes('system_admin');
  if (foundationOrgId) {
    requireOrgPermission(actor, foundationOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    ids = [foundationOrgId];
  } else if (!systemAdmin) {
    ids = [...new Set((actor.memberships || []).map(m => m.organizationId).filter(Boolean))];
    if (!ids.length) return [];
  }
  const params = [];
  const where = [];
  if (!(systemAdmin && !foundationOrgId)) { params.push(ids); where.push(`foundation_org_id=ANY($${params.length}::uuid[])`); }
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const { rows } = await repository.pool.query(`SELECT id FROM grant_offer_batches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  const batches = [];
  for (const row of rows) batches.push(await loadOfferBatch(repository, row.id));
  return batches;
}

async function actorForUser(repository, userId) {
  const user = (await repository.pool.query('SELECT id,oidc_subject,email,display_name FROM users WHERE id=$1', [userId])).rows[0];
  if (!user) throw new Error('Offer-batch creator user no longer exists.');
  const [global, memberships] = await Promise.all([
    repository.pool.query('SELECT role FROM user_global_roles WHERE user_id=$1', [userId]),
    repository.pool.query('SELECT organization_id,role FROM memberships WHERE user_id=$1', [userId])
  ]);
  return {
    id: user.id,
    subject: user.oidc_subject,
    email: user.email,
    displayName: user.display_name,
    roles: global.rows.map(row => row.role),
    memberships: memberships.rows.map(row => ({ organizationId: row.organization_id, role: row.role }))
  };
}

export async function runOneOfferBatch({ config, repository, batchId, t3010Repository }) {
  let batch = await loadOfferBatch(repository, batchId);
  if (!batch || ['offered','cancelled'].includes(batch.status)) return { skipped: true, reason: 'batch_complete_or_missing' };
  if (!config.recipientPortalEnabled || config.notificationProvider === 'disabled') return { skipped: true, reason: 'recipient_delivery_not_ready' };
  const actor = await actorForUser(repository, batch.createdBy);
  requireOrgPermission(actor, batch.foundationOrgId, PERMISSIONS.OFFER_GRANT);
  const { WorkflowService } = await import('./workflow_service.mjs');
  const service = new WorkflowService({ repository, t3010Repository, config });
  await seedPublicRecipientContacts(repository, t3010Repository, batch.items.map(item => item.recipientOrgId));
  let pending = 0;
  let offered = 0;
  let failed = 0;

  for (const item of batch.items) {
    if (item.status === 'offered') { offered += 1; continue; }
    if (['offered','accepted','payment_authorized','paid','reported'].includes(item.grantState)) {
      if (item.grantTermsVersion === batch.termsVersion && item.grantTermsDigest === batch.termsDigest) {
        await repository.pool.query(`UPDATE grant_offer_batch_items SET status='offered',last_error=NULL,updated_at=now() WHERE batch_id=$1 AND grant_id=$2`, [batch.id, item.grantId]);
        offered += 1;
        continue;
      }
      await repository.pool.query(`UPDATE grant_offer_batch_items SET status='failed',last_error='Grant already has different offer terms',updated_at=now() WHERE batch_id=$1 AND grant_id=$2`, [batch.id, item.grantId]);
      failed += 1;
      continue;
    }
    if (item.grantState !== 'approved') {
      await repository.pool.query(`UPDATE grant_offer_batch_items SET status='failed',last_error=$3,updated_at=now() WHERE batch_id=$1 AND grant_id=$2`, [batch.id, item.grantId, `Grant state ${item.grantState} is not offerable`]);
      failed += 1;
      continue;
    }

    const contact = await findVerifiedRecipientContact(repository, item.recipientOrgId, batch.preferredChannel);
    if (!contact) {
      let enrichment = null;
      let challenge = await ensureContactVerification(repository, {
        organizationId: item.recipientOrgId,
        preferredChannel: batch.preferredChannel,
        portalBaseUrl: config.recipientPortalBaseUrl,
        ttlHours: Math.min(config.offerTokenTtlHours || 72, 168)
      });
      if (!challenge.pending && challenge.reason === 'no_contact_candidate' && config.websiteContactEnrichmentEnabled) {
        enrichment = await seedWebsiteRecipientContacts(repository, t3010Repository, item.recipientOrgId, {
          enabled: true,
          timeoutMs: config.websiteContactTimeoutMs,
          maxBytes: config.websiteContactMaxBytes,
          maxPages: config.websiteContactMaxPages
        });
        challenge = await ensureContactVerification(repository, {
          organizationId: item.recipientOrgId,
          preferredChannel: batch.preferredChannel,
          portalBaseUrl: config.recipientPortalBaseUrl,
          ttlHours: Math.min(config.offerTokenTtlHours || 72, 168)
        });
      }
      const reason = challenge.pending
        ? 'Awaiting recipient contact verification'
        : enrichment?.reason || challenge.reason || 'No verified recipient contact is available';
      await repository.pool.query(`UPDATE grant_offer_batch_items SET status='pending_contact',last_error=$3,updated_at=now() WHERE batch_id=$1 AND grant_id=$2`,
        [batch.id, item.grantId, String(reason).slice(0, 4000)]);
      pending += 1;
      continue;
    }

    try {
      await service.offerGrant(actor, {
        grantId: item.grantId,
        termsVersion: batch.termsVersion,
        termsText: batch.termsText,
        notificationChannel: contact.channel,
        notificationRecipient: contact.destination,
        idempotencyKey: `offer-batch:${batch.id}:offer:${item.grantId}`
      });
      await repository.pool.query(`UPDATE grant_offer_batch_items SET contact_id=$3,status='offered',last_error=NULL,updated_at=now() WHERE batch_id=$1 AND grant_id=$2`, [batch.id, item.grantId, contact.id]);
      await repository.pool.query(`UPDATE recipient_contacts SET last_used_at=now(),updated_at=now() WHERE id=$1`, [contact.id]);
      offered += 1;
    } catch (error) {
      await repository.pool.query(`UPDATE grant_offer_batch_items SET status='failed',last_error=$3,updated_at=now() WHERE batch_id=$1 AND grant_id=$2`, [batch.id, item.grantId, String(error.message).slice(0, 4000)]);
      failed += 1;
    }
  }

  const status = failed > 0 ? 'partial' : pending > 0 ? 'pending_contacts' : 'offered';
  await repository.pool.query(`UPDATE grant_offer_batches SET status=$2,updated_at=now(),completed_at=CASE WHEN $2='offered' THEN now() ELSE completed_at END WHERE id=$1`, [batch.id, status]);
  batch = await loadOfferBatch(repository, batch.id);
  return { batchId: batch.id, status, offered, pending, failed };
}

export async function runOfferBatchesJob({ config, repository, dataDir, t3010Repository = null }) {
  if (!config.enableWorkflowWrites) return { skipped: true, reason: 'workflow_writes_disabled' };
  let publicData = t3010Repository;
  if (!publicData) {
    const { T3010Repository } = await import('../t3010/repository.mjs');
    publicData = new T3010Repository(dataDir);
    try { await publicData.load(); } catch (error) { return { skipped: true, reason: 't3010_not_loaded', error: error.message }; }
  }
  const { rows } = await repository.pool.query(`SELECT id FROM grant_offer_batches WHERE status IN ('pending_contacts','ready','offering','partial') ORDER BY created_at,id LIMIT $1`, [config.allocationPolicyBatchSize || 10]);
  const results = [];
  for (const row of rows) {
    try { results.push(await runOneOfferBatch({ config, repository, batchId: row.id, t3010Repository: publicData })); }
    catch (error) { results.push({ batchId: row.id, status: 'failed', error: error.message }); }
  }
  return { processed: results.length, results };
}
