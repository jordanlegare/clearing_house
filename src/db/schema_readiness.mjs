export const REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  'organizations',
  'grants',
  'audit_log',
  'recipient_status_checks',
  'recipient_status_verification_tasks',
  'compliance_reviews',
  'payment_intents',
  'notification_outbox',
  'automation_jobs',
  'automation_worker_heartbeats',
  'foundation_allocation_policies',
  'grant_review_bundles',
  'grant_offer_batches',
  'recipient_contacts',
  'recipient_contact_discovery',
  'recipient_contact_channel_discovery',
  'grant_reporting_metadata',
  'grant_reporting_metadata_commands',
  'fiscal_reporting_packages',
  'fiscal_reporting_submissions'
]);

export async function checkDatabaseSchema(pool) {
  if (!pool) return { ready: false, databaseReachable: false, missing: [...REQUIRED_SCHEMA_OBJECTS], error: 'Database pool is not configured.' };
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query(`
      SELECT required.name,
             to_regclass('public.' || required.name) IS NOT NULL AS present
      FROM unnest($1::text[]) AS required(name)
      ORDER BY required.name
    `, [REQUIRED_SCHEMA_OBJECTS]);
    const missing = rows.filter(row => !row.present).map(row => row.name);
    return {
      ready: missing.length === 0,
      databaseReachable: true,
      expectedObjects: REQUIRED_SCHEMA_OBJECTS.length,
      missing
    };
  } catch (error) {
    return {
      ready: false,
      databaseReachable: false,
      expectedObjects: REQUIRED_SCHEMA_OBJECTS.length,
      missing: [],
      error: error.message
    };
  }
}

export async function assertDatabaseSchema(pool) {
  const status = await checkDatabaseSchema(pool);
  if (!status.ready) {
    const detail = status.error || `missing required schema objects: ${status.missing.join(', ')}`;
    throw new Error(`Database schema readiness failed: ${detail}`);
  }
  return status;
}
