import { createDatabasePool } from '../src/db/pool.mjs';
import { assertDatabaseSchema } from '../src/db/schema_readiness.mjs';
import { loadRuntimeConfig } from '../src/config/requirements.mjs';

const config = loadRuntimeConfig();
let pool = null;
try {
  if (config.databaseUrl) {
    pool = createDatabasePool(config.databaseUrl, { max: 1 });
    await assertDatabaseSchema(pool);
  } else if (config.production || config.enableWorkflowWrites || config.automationEnabled) {
    throw new Error('DATABASE_URL is required for this runtime mode.');
  }
} finally {
  if (pool) await pool.end();
}

await import('../src/mcp/server.mjs');
