import { createDatabasePool } from '../src/db/pool.mjs';
import { verifyAuditChain } from '../src/security/audit_verify.mjs';

const databaseUrl = process.env.DATABASE_URL;
const key = process.env.AUDIT_HMAC_KEY;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
if (!key || key.length < 32) throw new Error('AUDIT_HMAC_KEY must be at least 32 characters.');

const pool = createDatabasePool(databaseUrl, { max: 2 });
try {
  const result = await verifyAuditChain(pool, key);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 2;
} finally {
  await pool.end();
}
