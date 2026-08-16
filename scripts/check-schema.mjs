import { createDatabasePool } from '../src/db/pool.mjs';
import { checkDatabaseSchema } from '../src/db/schema_readiness.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(JSON.stringify({ ready: false, error: 'DATABASE_URL is required.' }, null, 2));
  process.exit(2);
}

const pool = createDatabasePool(databaseUrl);
try {
  const status = await checkDatabaseSchema(pool);
  console.log(JSON.stringify(status, null, 2));
  if (!status.ready) process.exitCode = 2;
} finally {
  await pool.end();
}
