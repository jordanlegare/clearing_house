import pg from 'pg';

const { Pool } = pg;

export function createDatabasePool(databaseUrl, options = {}) {
  if (!databaseUrl) return null;
  return new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    ssl: options.ssl
  });
}

export async function withTransaction(pool, fn) {
  if (!pool) throw new Error('Database pool is not configured.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
