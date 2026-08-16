import crypto from 'node:crypto';
import { encryptText, decryptText } from '../security/crypto.mjs';
import { buildAuditEntry } from '../security/audit.mjs';

export class ContactChallengeError extends Error {
  constructor(message = 'This contact-verification link is invalid, expired, or already used.', statusCode = 410) {
    super(message);
    this.name = 'ContactChallengeError';
    this.statusCode = statusCode;
  }
}

function normalizedDestination(channel, value) {
  const text = String(value || '').trim();
  if (!['sms','voice'].includes(channel)) throw new Error('Contact channel must be sms or voice.');
  const digits = text.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  throw new Error('Recipient phone contact must be a valid Canada/US E.164-compatible number.');
}

function fingerprint(repository, channel, destination) {
  if (!repository.auditHmacKey || repository.auditHmacKey.length < 32) throw new Error('AUDIT_HMAC_KEY is required for contact fingerprints.');
  return crypto.createHmac('sha256', repository.auditHmacKey).update(`${channel}|${destination}`).digest('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function assertToken(token) {
  const value = String(token || '');
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(value)) throw new ContactChallengeError();
  return value;
}

export function buildContactVerificationUrl(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Recipient portal base URL must be an absolute HTTP(S) URL.');
  return `${base}/verify-contact/${encodeURIComponent(token)}`;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••-•••-${digits.slice(-4)}` : 'hidden';
}

async function appendAudit(repository, client, { actor = null, organizationId, action, resourceType, resourceId, requestId, payload }) {
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
  await client.query(`INSERT INTO audit_log
    (occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,request_id,payload_digest,previous_digest,entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [occurredAt, actor?.id || null, organizationId || null, action, resourceType, String(resourceId), requestId || null,
    entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

async function queueContactVerificationNotification(repository, client, { organizationId, contact, destination, challenge }) {
  if (!organizationId || !contact?.id || !challenge?.id) throw new Error('Contact-verification notification requires organization, contact and challenge identifiers.');
  if (!['sms','voice'].includes(contact.channel)) throw new Error('Contact-verification notification requires an SMS or voice channel.');
  const idempotencyKey = `contact-verification:${challenge.id}`;
  const existing = await client.query('SELECT id FROM notification_outbox WHERE idempotency_key=$1', [idempotencyKey]);
  if (existing.rows[0]) return existing.rows[0];
  const encryptedRecipient = encryptText(destination, repository.encryptionKey);
  const { rows } = await client.query(`
    INSERT INTO notification_outbox (grant_id,channel,recipient,template,payload,idempotency_key)
    VALUES (NULL,$1,$2,'contact_verification',$3::jsonb,$4)
    RETURNING id
  `, [contact.channel, encryptedRecipient, JSON.stringify({ challengeId: challenge.id, organizationId }), idempotencyKey]);
  return rows[0];
}

export async function seedPublicRecipientContacts(repository, t3010Repository, organizationIds = []) {
  if (!t3010Repository?.loaded) throw new Error('T3010 repository is required to seed public contacts.');
  const uniqueIds = [...new Set(organizationIds.filter(Boolean))];
  if (!uniqueIds.length) return { organizations: 0, candidates: 0 };
  const { rows: organizations } = await repository.pool.query(`
    SELECT id,business_number,legal_name FROM organizations WHERE id=ANY($1::uuid[])
  `, [uniqueIds]);
  let candidates = 0;
  for (const organization of organizations) {
    if (!organization.business_number) continue;
    const profile = t3010Repository.charityProfile(organization.business_number);
    for (const candidate of profile?.publicContactCandidates || []) {
      let destination;
      try { destination = normalizedDestination(candidate.channel, candidate.destination); } catch { continue; }
      const fp = fingerprint(repository, candidate.channel, destination);
      const encrypted = encryptText(destination, repository.encryptionKey);
      const inserted = await repository.pool.query(`
        INSERT INTO recipient_contacts
          (organization_id,channel,destination_encrypted,destination_fingerprint,source,source_evidence)
        VALUES ($1,$2,$3,$4,'t3010_public',$5::jsonb)
        ON CONFLICT (organization_id,channel,destination_fingerprint) DO NOTHING
        RETURNING id
      `, [organization.id, candidate.channel, encrypted, fp, JSON.stringify({
        sourceYear: profile.sourceYear,
        sourceKey: candidate.sourceKey,
        publicSource: 'CRA T3010/Open Government Canada'
      })]);
      candidates += inserted.rowCount;
    }
  }
  return { organizations: organizations.length, candidates };
}

export async function findVerifiedRecipientContact(repository, organizationId, preferredChannel = 'sms') {
  const { rows } = await repository.pool.query(`
    SELECT * FROM recipient_contacts
    WHERE organization_id=$1 AND status='verified'
    ORDER BY CASE WHEN channel=$2 THEN 0 ELSE 1 END, verified_at DESC, created_at
    LIMIT 1
  `, [organizationId, preferredChannel]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    channel: row.channel,
    destination: decryptText(row.destination_encrypted, repository.encryptionKey),
    verifiedAt: row.verified_at?.toISOString?.() || row.verified_at,
    source: row.source,
    verificationMethod: row.verification_method
  };
}

async function chooseCandidate(repository, organizationId, preferredChannel) {
  const { rows } = await repository.pool.query(`
    SELECT * FROM recipient_contacts
    WHERE organization_id=$1 AND status IN ('candidate','verification_pending')
    ORDER BY CASE WHEN channel=$2 THEN 0 ELSE 1 END, created_at
    LIMIT 1
  `, [organizationId, preferredChannel]);
  return rows[0] || null;
}

export async function ensureContactVerification(repository, { organizationId, preferredChannel = 'sms', portalBaseUrl, ttlHours = 72 }) {
  const verified = await findVerifiedRecipientContact(repository, organizationId, preferredChannel);
  if (verified) return { verified: true, contact: verified };
  const contact = await chooseCandidate(repository, organizationId, preferredChannel);
  if (!contact) return { verified: false, pending: false, reason: 'no_contact_candidate' };
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recipient-contact:${contact.id}`]);
    const active = (await client.query(`
      SELECT * FROM recipient_contact_challenges
      WHERE contact_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1
    `, [contact.id])).rows[0];
    let challenge = active;
    let token;
    if (challenge) {
      token = decryptText(challenge.token_secret_encrypted, repository.encryptionKey);
    } else {
      await client.query(`UPDATE recipient_contact_challenges SET revoked_at=COALESCE(revoked_at,now()) WHERE contact_id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [contact.id]);
      token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + Math.min(Math.max(Number(ttlHours) || 72, 1), 168) * 3600 * 1000).toISOString();
      challenge = (await client.query(`
        INSERT INTO recipient_contact_challenges (contact_id,token_hash,token_secret_encrypted,expires_at)
        VALUES ($1,$2,$3,$4) RETURNING *
      `, [contact.id, tokenHash(token), encryptText(token, repository.encryptionKey), expiresAt])).rows[0];
      await client.query(`UPDATE recipient_contacts SET status='verification_pending',updated_at=now() WHERE id=$1`, [contact.id]);
      const destination = decryptText(contact.destination_encrypted, repository.encryptionKey);
      await queueContactVerificationNotification(repository, client, { organizationId, contact, destination, challenge });
      await appendAudit(repository, client, {
        organizationId,
        action: 'recipient_contact.verification_queued',
        resourceType: 'recipient_contact',
        resourceId: contact.id,
        requestId: `contact-verification:${challenge.id}`,
        payload: { channel: contact.channel, source: contact.source, expiresAt }
      });
    }
    await client.query('COMMIT');
    return {
      verified: false,
      pending: true,
      contactId: contact.id,
      challengeId: challenge.id,
      url: buildContactVerificationUrl(portalBaseUrl, token),
      expiresAt: challenge.expires_at?.toISOString?.() || challenge.expires_at
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function getContactChallengeForNotification(repository, challengeId, portalBaseUrl) {
  const { rows } = await repository.pool.query(`
    SELECT c.*,rc.organization_id,rc.channel,rc.status,o.legal_name
    FROM recipient_contact_challenges c
    JOIN recipient_contacts rc ON rc.id=c.contact_id
    JOIN organizations o ON o.id=rc.organization_id
    WHERE c.id=$1
  `, [challengeId]);
  const row = rows[0];
  if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw new ContactChallengeError();
  const token = decryptText(row.token_secret_encrypted, repository.encryptionKey);
  return {
    challengeId: row.id,
    organizationId: row.organization_id,
    organizationName: row.legal_name,
    channel: row.channel,
    url: buildContactVerificationUrl(portalBaseUrl, token),
    expiresAt: row.expires_at?.toISOString?.() || row.expires_at
  };
}

export async function inspectContactChallenge(repository, rawToken) {
  const token = assertToken(rawToken);
  const { rows } = await repository.pool.query(`
    SELECT c.*,rc.organization_id,rc.channel,rc.destination_encrypted,rc.status,o.legal_name
    FROM recipient_contact_challenges c
    JOIN recipient_contacts rc ON rc.id=c.contact_id
    JOIN organizations o ON o.id=rc.organization_id
    WHERE c.token_hash=$1 LIMIT 1
  `, [tokenHash(token)]);
  const row = rows[0];
  if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw new ContactChallengeError();
  const destination = decryptText(row.destination_encrypted, repository.encryptionKey);
  return {
    challengeId: row.id,
    contactId: row.contact_id,
    organizationId: row.organization_id,
    organizationName: row.legal_name,
    channel: row.channel,
    maskedDestination: maskPhone(destination),
    expiresAt: row.expires_at?.toISOString?.() || row.expires_at
  };
}

export async function verifyContactChallenge(repository, rawToken) {
  const token = assertToken(rawToken);
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT c.*,rc.organization_id,rc.channel,rc.destination_encrypted,o.legal_name
      FROM recipient_contact_challenges c
      JOIN recipient_contacts rc ON rc.id=c.contact_id
      JOIN organizations o ON o.id=rc.organization_id
      WHERE c.token_hash=$1
      FOR UPDATE OF c,rc
    `, [tokenHash(token)]);
    const row = rows[0];
    if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw new ContactChallengeError();
    await client.query(`UPDATE recipient_contact_challenges SET used_at=now() WHERE id=$1`, [row.id]);
    await client.query(`UPDATE recipient_contact_challenges SET revoked_at=COALESCE(revoked_at,now()) WHERE contact_id=$1 AND id<>$2 AND used_at IS NULL AND revoked_at IS NULL`, [row.contact_id, row.id]);
    await client.query(`
      UPDATE recipient_contacts SET status='verified',verification_method='public_t3010_channel_control',verified_at=now(),updated_at=now()
      WHERE id=$1
    `, [row.contact_id]);
    await appendAudit(repository, client, {
      organizationId: row.organization_id,
      action: 'recipient_contact.verified',
      resourceType: 'recipient_contact',
      resourceId: row.contact_id,
      requestId: `contact-challenge:${row.id}:verify`,
      payload: { channel: row.channel, verificationMethod: 'public_t3010_channel_control' }
    });
    await client.query('COMMIT');
    return {
      contactId: row.contact_id,
      organizationId: row.organization_id,
      organizationName: row.legal_name,
      channel: row.channel,
      verified: true
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
