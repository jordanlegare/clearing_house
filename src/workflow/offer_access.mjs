import crypto from 'node:crypto';
import { withTransaction } from '../db/pool.mjs';
import { buildAuditEntry } from '../security/audit.mjs';
import { encryptText, decryptText } from '../security/crypto.mjs';

export class OfferAccessError extends Error {
  constructor(message = 'This funding-offer link is invalid, expired, or already used.', statusCode = 410) {
    super(message);
    this.name = 'OfferAccessError';
    this.statusCode = statusCode;
  }
}

export function offerTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function buildOfferUrl(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Recipient portal base URL must be an absolute HTTP(S) URL.');
  return `${base}/offer/${encodeURIComponent(token)}`;
}

function assertTokenShape(token) {
  const value = String(token || '');
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(value)) throw new OfferAccessError();
  return value;
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
  await client.query(`
    INSERT INTO audit_log
      (occurred_at, actor_user_id, organization_id, action, resource_type, resource_id, request_id, payload_digest, previous_digest, entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [occurredAt, actor?.id || null, organizationId || null, action, resourceType, String(resourceId), requestId || null, entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

function offerView(row) {
  if (!row) return null;
  return {
    tokenId: row.token_id,
    grantId: row.grant_id,
    state: row.grant_state,
    amountCad: Number(row.amount_cad),
    purpose: row.purpose,
    termsVersion: row.terms_version,
    termsText: row.terms_text,
    offeredAt: row.offered_at?.toISOString?.() || row.offered_at || null,
    expiresAt: row.expires_at?.toISOString?.() || row.expires_at || null,
    foundation: { id: row.foundation_org_id, name: row.foundation_name },
    recipient: { id: row.recipient_org_id, name: row.recipient_name, businessNumber: row.recipient_bn || null }
  };
}

async function grantOfferRow(client, grantId, { forUpdate = false } = {}) {
  const lock = forUpdate ? 'FOR UPDATE OF g' : '';
  const { rows } = await client.query(`
    SELECT g.id AS grant_id, g.state AS grant_state, g.foundation_org_id, g.recipient_org_id,
      g.amount_cad, g.purpose, g.terms_version, g.terms_digest, g.terms_text, g.offered_at,
      f.legal_name AS foundation_name, r.legal_name AS recipient_name, r.business_number AS recipient_bn
    FROM grants g
    JOIN organizations f ON f.id=g.foundation_org_id
    JOIN organizations r ON r.id=g.recipient_org_id
    WHERE g.id=$1
    ${lock}
  `, [grantId]);
  return rows[0] || null;
}

export async function ensureOfferAccess({ repository, grantId, portalBaseUrl, ttlHours = 168, actor = null, requestId = null }) {
  if (!repository?.pool) throw new Error('Workflow repository is required.');
  if (!repository.encryptionKey || repository.encryptionKey.length < 32) throw new Error('ENCRYPTION_KEY is required for recipient offer links.');
  const ttl = Number(ttlHours);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 720) throw new Error('Offer-link TTL must be an integer between 1 and 720 hours.');

  return withTransaction(repository.pool, async client => {
    const grant = await grantOfferRow(client, grantId, { forUpdate: true });
    if (!grant || grant.grant_state !== 'offered' || !grant.terms_version || !grant.terms_digest) {
      throw new Error('Recipient offer access can be issued only for a currently offered grant with versioned terms.');
    }

    const active = (await client.query(`
      SELECT id AS token_id, token_secret_encrypted, terms_digest, expires_at
      FROM offer_access_tokens
      WHERE grant_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1
      FOR UPDATE
    `, [grantId])).rows[0];

    if (active?.token_secret_encrypted && active.terms_digest === grant.terms_digest) {
      const token = decryptText(active.token_secret_encrypted, repository.encryptionKey);
      return {
        tokenId: active.token_id,
        token,
        url: buildOfferUrl(portalBaseUrl, token),
        expiresAt: active.expires_at?.toISOString?.() || active.expires_at,
        reused: true
      };
    }

    await client.query(`
      UPDATE offer_access_tokens SET revoked_at=COALESCE(revoked_at, now())
      WHERE grant_id=$1 AND used_at IS NULL AND revoked_at IS NULL
    `, [grantId]);

    const token = crypto.randomBytes(32).toString('base64url');
    const hash = offerTokenHash(token);
    const encrypted = encryptText(token, repository.encryptionKey);
    const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();
    const inserted = (await client.query(`
      INSERT INTO offer_access_tokens
        (grant_id, token_hash, token_secret_encrypted, terms_digest, expires_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, expires_at
    `, [grantId, hash, encrypted, grant.terms_digest, expiresAt, actor?.id || null])).rows[0];

    await appendAudit(repository, client, {
      actor,
      organizationId: grant.foundation_org_id,
      action: 'offer_access.issued',
      resourceType: 'offer_access_token',
      resourceId: inserted.id,
      requestId,
      payload: { grantId, termsVersion: grant.terms_version, expiresAt, delivery: 'capability_link' }
    });

    return {
      tokenId: inserted.id,
      token,
      url: buildOfferUrl(portalBaseUrl, token),
      expiresAt: inserted.expires_at?.toISOString?.() || inserted.expires_at,
      reused: false
    };
  });
}

export async function inspectOfferAccess(repository, rawToken) {
  const token = assertTokenShape(rawToken);
  const hash = offerTokenHash(token);
  const { rows } = await repository.pool.query(`
    SELECT oat.id AS token_id, oat.expires_at, oat.used_at, oat.revoked_at, oat.terms_digest AS token_terms_digest,
      g.id AS grant_id, g.state AS grant_state, g.foundation_org_id, g.recipient_org_id,
      g.amount_cad, g.purpose, g.terms_version, g.terms_digest, g.terms_text, g.offered_at,
      f.legal_name AS foundation_name, r.legal_name AS recipient_name, r.business_number AS recipient_bn
    FROM offer_access_tokens oat
    JOIN grants g ON g.id=oat.grant_id
    JOIN organizations f ON f.id=g.foundation_org_id
    JOIN organizations r ON r.id=g.recipient_org_id
    WHERE oat.token_hash=$1
    LIMIT 1
  `, [hash]);
  const row = rows[0];
  if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw new OfferAccessError();
  if (row.grant_state !== 'offered' || !row.terms_digest || row.token_terms_digest !== row.terms_digest) throw new OfferAccessError();
  return offerView(row);
}

export async function consumeOfferAccess(repository, rawToken, action) {
  const token = assertTokenShape(rawToken);
  if (!['accept','decline'].includes(action)) throw new Error('Offer action must be accept or decline.');
  const hash = offerTokenHash(token);

  return withTransaction(repository.pool, async client => {
    const { rows } = await client.query(`
      SELECT oat.id AS token_id, oat.expires_at, oat.used_at, oat.revoked_at, oat.terms_digest AS token_terms_digest,
        g.id AS grant_id, g.state AS grant_state, g.foundation_org_id, g.recipient_org_id,
        g.amount_cad, g.purpose, g.terms_version, g.terms_digest, g.terms_text, g.offered_at,
        f.legal_name AS foundation_name, r.legal_name AS recipient_name, r.business_number AS recipient_bn
      FROM offer_access_tokens oat
      JOIN grants g ON g.id=oat.grant_id
      JOIN organizations f ON f.id=g.foundation_org_id
      JOIN organizations r ON r.id=g.recipient_org_id
      WHERE oat.token_hash=$1
      FOR UPDATE OF oat, g
    `, [hash]);
    const row = rows[0];
    if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw new OfferAccessError();
    if (row.grant_state !== 'offered' || !row.terms_digest || row.token_terms_digest !== row.terms_digest) throw new OfferAccessError();

    const nextState = action === 'accept' ? 'accepted' : 'declined';
    const eventKey = `offer-token:${row.token_id}:${action}`;
    await client.query(`UPDATE grants SET state=$2, accepted_by=NULL, updated_at=now() WHERE id=$1`, [row.grant_id, nextState]);
    await client.query(`
      INSERT INTO recipient_consents
        (grant_id, user_id, terms_version, accepted, metadata, acceptance_method, offer_token_id)
      VALUES ($1,NULL,$2,$3,$4::jsonb,'offer_token',$5)
    `, [row.grant_id, row.terms_version, action === 'accept', JSON.stringify({ action, capabilityToken: true }), row.token_id]);
    await client.query('UPDATE offer_access_tokens SET used_at=now() WHERE id=$1', [row.token_id]);
    await client.query(`
      UPDATE offer_access_tokens SET revoked_at=COALESCE(revoked_at, now())
      WHERE grant_id=$1 AND id<>$2 AND used_at IS NULL AND revoked_at IS NULL
    `, [row.grant_id, row.token_id]);
    await client.query(`
      INSERT INTO grant_events (grant_id, idempotency_key, from_state, to_state, actor_user_id, metadata)
      VALUES ($1,$2,'offered',$3,NULL,$4::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [row.grant_id, eventKey, nextState, JSON.stringify({ acceptanceMethod: 'offer_token', offerTokenId: row.token_id, termsVersion: row.terms_version })]);

    await appendAudit(repository, client, {
      actor: null,
      organizationId: row.foundation_org_id,
      action: action === 'accept' ? 'grant.accepted_by_offer_token' : 'grant.declined_by_offer_token',
      resourceType: 'grant',
      resourceId: row.grant_id,
      requestId: eventKey,
      payload: { grantId: row.grant_id, termsVersion: row.terms_version, acceptanceMethod: 'offer_token' }
    });

    return { ...offerView({ ...row, grant_state: nextState }), action, state: nextState };
  });
}
