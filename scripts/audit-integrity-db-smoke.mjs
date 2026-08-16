import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { buildAuditEntry } from '../src/security/audit.mjs';
import { verifyAuditChain } from '../src/security/audit_verify.mjs';

const databaseUrl = process.env.DATABASE_URL;
const key = process.env.AUDIT_HMAC_KEY;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
if (!key || key.length < 32) throw new Error('AUDIT_HMAC_KEY must be at least 32 characters.');
const pool = createDatabasePool(databaseUrl);

try {
  const before = await verifyAuditChain(pool, key);
  assert.equal(before.valid, true, JSON.stringify(before));

  const client = await pool.connect();
  let sequence;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [742019301]);
    const previous = (await client.query('SELECT entry_hmac FROM audit_log ORDER BY sequence DESC LIMIT 1')).rows[0]?.entry_hmac || '';
    const occurredAt = new Date().toISOString();
    const action = 'audit_integrity.smoke';
    const entry = buildAuditEntry({
      key,
      previousDigest: previous,
      occurredAt,
      action,
      resourceType: 'audit_test',
      resourceId: 'integrity-smoke',
      requestId: 'audit-integrity-smoke',
      payload: { purpose: 'prove tamper detection' }
    });
    sequence = (await client.query(`
      INSERT INTO audit_log
        (occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,request_id,payload_digest,previous_digest,entry_hmac)
      VALUES ($1,NULL,NULL,$2,'audit_test','integrity-smoke','audit-integrity-smoke',$3,$4,$5)
      RETURNING sequence
    `, [occurredAt, action, entry.payloadDigest, entry.previousDigest, entry.entryHmac])).rows[0].sequence;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const valid = await verifyAuditChain(pool, key);
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(valid.lastSequence, Number(sequence));

  await pool.query(`UPDATE audit_log SET action='audit_integrity.tampered' WHERE sequence=$1`, [sequence]);
  const tampered = await verifyAuditChain(pool, key);
  assert.equal(tampered.valid, false);
  assert.equal(tampered.failureSequence, Number(sequence));
  assert.equal(tampered.reason, 'entry_hmac_mismatch');

  await pool.query(`UPDATE audit_log SET action='audit_integrity.smoke' WHERE sequence=$1`, [sequence]);
  const restored = await verifyAuditChain(pool, key);
  assert.equal(restored.valid, true, JSON.stringify(restored));

  console.log(JSON.stringify({
    ok: true,
    rowsChecked: restored.checked,
    tamperSequence: Number(sequence),
    tamperReason: tampered.reason,
    lastHmac: restored.lastHmac
  }, null, 2));
} finally {
  await pool.end();
}
