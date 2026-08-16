import { withTransaction } from '../db/pool.mjs';
import { buildAuditEntry } from '../security/audit.mjs';
import { encryptText } from '../security/crypto.mjs';
import { PERMISSIONS, requireOrgPermission } from '../security/rbac.mjs';
import { checkCraPublicEvidence } from '../status/cra-evidence.mjs';

function riskFromDiligence({ relationshipExperience, amountCad, durationMonths, writtenAgreement, separateLedger, researchSummary }) {
  let points = 0;
  if (relationshipExperience === 'none') points += 2;
  else if (relationshipExperience === 'some') points += 1;
  if (amountCad > 250_000) points += 2;
  else if (amountCad > 50_000) points += 1;
  if (durationMonths > 24) points += 2;
  else if (durationMonths > 12) points += 1;
  if (!writtenAgreement) points += 2;
  if (!separateLedger) points += 1;
  if (!String(researchSummary || '').trim()) points += 1;
  return { points, risk: points >= 6 ? 'high' : points >= 3 ? 'medium' : 'low' };
}

async function appendAudit(repository, client, { actor, organizationId, action, resourceType, resourceId, requestId, payload }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [742019301]);
  const previous = await client.query('SELECT entry_hmac FROM audit_log ORDER BY sequence DESC LIMIT 1');
  const occurredAt = new Date().toISOString();
  const entry = buildAuditEntry({
    key: repository.auditHmacKey,
    previousDigest: previous.rows[0]?.entry_hmac || '',
    occurredAt,
    actorUserId: actor?.id || '',
    organizationId: organizationId || '',
    action,
    resourceType,
    resourceId: String(resourceId),
    requestId: requestId || '',
    payload
  });
  await client.query(`
    INSERT INTO audit_log
      (occurred_at, actor_user_id, organization_id, action, resource_type, resource_id, request_id, payload_digest, previous_digest, entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [occurredAt, actor?.id || null, organizationId || null, action, resourceType, String(resourceId), requestId || null, entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

async function grantFor(service, actor, grantId, permission) {
  if (!actor?.id) throw new Error('Authentication is required.');
  const grant = await service.repository.getGrant(grantId);
  if (!grant) throw new Error('Grant not found.');
  requireOrgPermission(actor, grant.foundationOrgId, permission);
  return grant;
}

export async function prepareNqdDiligence(service, actor, {
  grantId,
  charitablePurposeAlignment,
  activityDescription,
  activityLocation = '',
  durationMonths = 12,
  relationshipExperience = 'none',
  researchSummary = '',
  writtenAgreement = true,
  reportingPlan = 'final_report',
  periodicTransfers = false,
  separateLedger = true,
  notes = '',
  idempotencyKey
}) {
  const grant = await grantFor(service, actor, grantId, PERMISSIONS.PROPOSE_GRANT);
  if (grant.recipientType !== 'non_qualified_donee') throw new Error('Diligence is required only for non-qualified-donee grants.');
  const { points, risk } = riskFromDiligence({
    relationshipExperience,
    amountCad: grant.amountCad,
    durationMonths,
    writtenAgreement,
    separateLedger,
    researchSummary
  });
  const assessment = {
    charitablePurposeAlignment,
    activityDescription,
    activityLocation,
    durationMonths,
    relationshipExperience,
    researchSummary,
    writtenAgreement,
    reportingPlan,
    periodicTransfers,
    separateLedger,
    notes,
    riskPoints: points,
    model: 'reasonable_flexible_proportionate_due_diligence'
  };

  return withTransaction(service.repository.pool, async client => {
    const row = (await client.query(`
      INSERT INTO grantee_diligence (grant_id, assessment, recommended_risk, status, prepared_by)
      VALUES ($1,$2::jsonb,$3,'draft',$4)
      ON CONFLICT (grant_id) DO UPDATE SET
        assessment=EXCLUDED.assessment,
        recommended_risk=EXCLUDED.recommended_risk,
        status='draft',
        prepared_by=EXCLUDED.prepared_by,
        approved_by=NULL,
        updated_at=now()
      RETURNING *
    `, [grantId, JSON.stringify(assessment), risk, actor.id])).rows[0];
    await appendAudit(service.repository, client, {
      actor,
      organizationId: grant.foundationOrgId,
      action: 'grantee_diligence.prepared',
      resourceType: 'grantee_diligence',
      resourceId: grantId,
      requestId: idempotencyKey,
      payload: { grantId, recommendedRisk: risk, riskPoints: points }
    });
    return row;
  });
}

export async function approveNqdDiligence(service, actor, { grantId, idempotencyKey }) {
  const grant = await grantFor(service, actor, grantId, PERMISSIONS.REVIEW_COMPLIANCE);
  if (grant.recipientType !== 'non_qualified_donee') throw new Error('Diligence approval is required only for non-qualified-donee grants.');
  return withTransaction(service.repository.pool, async client => {
    const existing = (await client.query('SELECT * FROM grantee_diligence WHERE grant_id=$1 FOR UPDATE', [grantId])).rows[0];
    if (!existing) throw new Error('Diligence record not found.');
    if (existing.prepared_by === actor.id) throw new Error('Separation of duties: diligence preparer cannot approve the same record.');
    if (existing.status === 'approved') return existing;
    const row = (await client.query(`
      UPDATE grantee_diligence SET status='approved', approved_by=$2, updated_at=now()
      WHERE grant_id=$1 RETURNING *
    `, [grantId, actor.id])).rows[0];
    await appendAudit(service.repository, client, {
      actor,
      organizationId: grant.foundationOrgId,
      action: 'grantee_diligence.approved',
      resourceType: 'grantee_diligence',
      resourceId: grantId,
      requestId: idempotencyKey,
      payload: { grantId, preparedBy: existing.prepared_by, approvedBy: actor.id }
    });
    return row;
  });
}

export async function getNqdDiligence(service, actor, { grantId }) {
  const grant = await grantFor(service, actor, grantId, PERMISSIONS.READ_PRIVATE_ORG);
  const { rows } = await service.repository.pool.query('SELECT * FROM grantee_diligence WHERE grant_id=$1', [grant.id]);
  return rows[0] || null;
}

export async function recordBankingVerification(service, actor, {
  grantId,
  status,
  externalReference,
  evidence = {},
  expiresAt = null,
  idempotencyKey
}) {
  const grant = await grantFor(service, actor, grantId, PERMISSIONS.AUTHORIZE_PAYMENT);
  if (!['verified','needs_review','failed','expired'].includes(status)) throw new Error(`Unsupported banking verification status: ${status}`);
  if (!String(externalReference || '').trim()) throw new Error('externalReference is required.');
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) throw new Error('expiresAt must be a valid timestamp.');

  return withTransaction(service.repository.pool, async client => {
    const existing = (await client.query('SELECT * FROM banking_verifications WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
    if (existing) return { ...existing, external_reference_encrypted: '[encrypted]' };
    const encryptedReference = encryptText(externalReference, service.repository.encryptionKey);
    const row = (await client.query(`
      INSERT INTO banking_verifications
        (grant_id, status, external_reference_encrypted, evidence, verified_by, verified_at, expires_at, idempotency_key)
      VALUES ($1,$2,$3,$4::jsonb,$5,now(),$6,$7)
      RETURNING *
    `, [grantId, status, encryptedReference, JSON.stringify(evidence || {}), actor.id, expiresAt, idempotencyKey])).rows[0];
    await appendAudit(service.repository, client, {
      actor,
      organizationId: grant.foundationOrgId,
      action: `banking_verification.${status}`,
      resourceType: 'banking_verification',
      resourceId: row.id,
      requestId: idempotencyKey,
      payload: { grantId, status, expiresAt, evidence }
    });
    return { ...row, external_reference_encrypted: '[encrypted]' };
  });
}

export async function createManualPaymentIntent(service, actor, { grantId, idempotencyKey }) {
  const grant = await grantFor(service, actor, grantId, PERMISSIONS.AUTHORIZE_PAYMENT);
  if (service.config.paymentProvider !== 'manual') throw new Error('PAYMENT_PROVIDER must be manual before a payment intent can be created.');
  if (grant.state !== 'accepted') throw new Error(`Payment intent can be created only for an accepted grant; current state is ${grant.state}.`);

  return withTransaction(service.repository.pool, async client => {
    const replay = (await client.query('SELECT * FROM payment_intents WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
    if (replay) return replay;
    const existing = (await client.query('SELECT * FROM payment_intents WHERE grant_id=$1 FOR UPDATE', [grantId])).rows[0];
    if (existing) throw new Error('A payment intent already exists for this grant.');
    const bank = (await client.query(`
      SELECT * FROM banking_verifications
      WHERE grant_id=$1 AND status='verified' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY verified_at DESC LIMIT 1
    `, [grantId])).rows[0];
    if (!bank) throw new Error('Fresh verified external banking evidence is required before payment intent creation.');
    const row = (await client.query(`
      INSERT INTO payment_intents
        (grant_id, provider, amount_cad, status, created_by, idempotency_key, metadata)
      VALUES ($1,'manual',$2,'created',$3,$4,$5::jsonb)
      RETURNING *
    `, [grantId, grant.amountCad, actor.id, idempotencyKey, JSON.stringify({ bankingVerificationId: bank.id })])).rows[0];
    await appendAudit(service.repository, client, {
      actor,
      organizationId: grant.foundationOrgId,
      action: 'payment_intent.created',
      resourceType: 'payment_intent',
      resourceId: row.id,
      requestId: idempotencyKey,
      payload: { grantId, amountCad: grant.amountCad, bankingVerificationId: bank.id }
    });
    return row;
  });
}

export async function getCraPublicEvidence(service, { businessNumber }) {
  const normalized = String(businessNumber || '').toUpperCase().replace(/[\s-]/g, '');
  const profile = service.t3010Repository?.loaded ? service.t3010Repository.charityProfile(normalized) : null;
  return checkCraPublicEvidence({ businessNumber: normalized, t3010Profile: profile });
}
