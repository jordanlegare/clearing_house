import { createDatabasePool } from '../src/db/pool.mjs';
import { loadRuntimeConfig } from '../src/config/requirements.mjs';

const config = loadRuntimeConfig();
const subject = process.env.BOOTSTRAP_ADMIN_SUBJECT;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL || null;
if (!config.databaseUrl) throw new Error('DATABASE_URL is required.');
if (!subject) throw new Error('BOOTSTRAP_ADMIN_SUBJECT is required. Use the exact OIDC sub for the initial operator.');
if (config.production && process.env.BOOTSTRAP_ADMIN_CONFIRM !== `BOOTSTRAP ${subject}`) {
  throw new Error(`Production bootstrap requires BOOTSTRAP_ADMIN_CONFIRM="BOOTSTRAP ${subject}".`);
}

const pool = createDatabasePool(config.databaseUrl);
try {
  const user = (await pool.query(`
    INSERT INTO users (oidc_subject, email, display_name) VALUES ($1,$2,'Bootstrap administrator')
    ON CONFLICT (oidc_subject) DO UPDATE SET email=COALESCE(EXCLUDED.email, users.email)
    RETURNING id, oidc_subject, email
  `, [subject, email])).rows[0];
  await pool.query(`INSERT INTO user_global_roles (user_id, role) VALUES ($1,'system_admin') ON CONFLICT DO NOTHING`, [user.id]);
  console.log(JSON.stringify({ bootstrapped: true, user: { id: user.id, subject: user.oidc_subject, email: user.email }, role: 'system_admin' }, null, 2));
} finally {
  await pool.end();
}
