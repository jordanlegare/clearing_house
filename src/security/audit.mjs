import crypto from 'node:crypto';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function payloadDigest(payload) {
  return crypto.createHash('sha256').update(canonical(payload ?? {})).digest('hex');
}

export function buildAuditEntry({
  key,
  previousDigest = '',
  occurredAt,
  actorUserId = '',
  organizationId = '',
  action,
  resourceType,
  resourceId,
  requestId = '',
  payload = {}
}) {
  if (!key || key.length < 32) throw new Error('AUDIT_HMAC_KEY must be at least 32 characters.');
  const digest = payloadDigest(payload);
  const material = [previousDigest, occurredAt, actorUserId, organizationId, action, resourceType, resourceId, requestId, digest].join('|');
  const entryHmac = crypto.createHmac('sha256', key).update(material).digest('hex');
  return { payloadDigest: digest, previousDigest: previousDigest || null, entryHmac };
}
