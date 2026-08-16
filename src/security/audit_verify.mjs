import crypto from 'node:crypto';
import { auditEntryHmacFromDigest } from './audit.mjs';

function asIso(value) {
  if (!value) throw new Error('Audit row is missing occurred_at.');
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Audit row has an invalid occurred_at timestamp.');
  return date.toISOString();
}

function sameHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(String(a || '')) || !/^[a-f0-9]{64}$/i.test(String(b || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export async function verifyAuditChain(pool, key, { batchSize = 5000 } = {}) {
  if (!pool) throw new Error('Database pool is required to verify the audit chain.');
  if (!key || key.length < 32) throw new Error('AUDIT_HMAC_KEY must be at least 32 characters.');
  const limit = Math.min(Math.max(Number(batchSize) || 5000, 100), 20_000);
  let afterSequence = 0;
  let expectedPrevious = null;
  let checked = 0;
  let firstSequence = null;
  let lastSequence = null;
  let lastHmac = null;

  while (true) {
    const { rows } = await pool.query(`
      SELECT sequence,occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,
             request_id,payload_digest,previous_digest,entry_hmac
      FROM audit_log
      WHERE sequence > $1
      ORDER BY sequence ASC
      LIMIT $2
    `, [afterSequence, limit]);
    if (!rows.length) break;

    for (const row of rows) {
      if (firstSequence === null) firstSequence = Number(row.sequence);
      const previous = row.previous_digest || null;
      if (previous !== expectedPrevious) {
        return {
          valid: false,
          checked,
          firstSequence,
          lastSequence,
          failureSequence: Number(row.sequence),
          reason: 'previous_digest_mismatch',
          expectedPrevious,
          actualPrevious: previous
        };
      }
      const expectedHmac = auditEntryHmacFromDigest({
        key,
        previousDigest: previous || '',
        occurredAt: asIso(row.occurred_at),
        actorUserId: row.actor_user_id || '',
        organizationId: row.organization_id || '',
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        requestId: row.request_id || '',
        payloadDigest: row.payload_digest
      });
      if (!sameHex(expectedHmac, row.entry_hmac)) {
        return {
          valid: false,
          checked,
          firstSequence,
          lastSequence,
          failureSequence: Number(row.sequence),
          reason: 'entry_hmac_mismatch'
        };
      }
      checked += 1;
      lastSequence = Number(row.sequence);
      lastHmac = row.entry_hmac;
      expectedPrevious = row.entry_hmac;
      afterSequence = Number(row.sequence);
    }
    if (rows.length < limit) break;
  }

  return {
    valid: true,
    checked,
    firstSequence,
    lastSequence,
    lastHmac,
    verifiedAt: new Date().toISOString()
  };
}
