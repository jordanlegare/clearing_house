const TRUE = new Set(['1', 'true', 'yes', 'on']);

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE.has(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, got ${value}`);
  return parsed;
}

export function loadRuntimeConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  return {
    nodeEnv,
    production,
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    databaseUrl: env.DATABASE_URL || '',
    oidcIssuer: env.OIDC_ISSUER || '',
    oidcClientId: env.OIDC_CLIENT_ID || '',
    oidcAudience: env.OIDC_AUDIENCE || '',
    encryptionKey: env.ENCRYPTION_KEY || '',
    auditHmacKey: env.AUDIT_HMAC_KEY || '',
    notificationProvider: env.NOTIFICATION_PROVIDER || 'disabled',
    paymentProvider: env.PAYMENT_PROVIDER || 'disabled',
    enableWorkflowWrites: bool(env.ENABLE_WORKFLOW_WRITES, false),
    enableT3010Sync: bool(env.ENABLE_T3010_SYNC, false),
    craStatusMaxAgeHours: positiveInt(env.CRA_STATUS_MAX_AGE_HOURS, 24),
    retentionDays: positiveInt(env.RETENTION_DAYS, 2555),
    requireSeparationOfDuties: bool(env.REQUIRE_SEPARATION_OF_DUTIES, true)
  };
}

export function assessReadiness(config) {
  const blockers = [];
  const warnings = [];

  if (config.production) {
    if (!config.publicBaseUrl.startsWith('https://')) blockers.push('PUBLIC_BASE_URL must use HTTPS in production.');
    if (!config.databaseUrl) blockers.push('DATABASE_URL is required in production.');
    if (config.enableWorkflowWrites && !config.oidcIssuer) blockers.push('OIDC_ISSUER is required when workflow writes are enabled.');
    if (config.enableWorkflowWrites && !config.oidcClientId) blockers.push('OIDC_CLIENT_ID is required when workflow writes are enabled.');
    if (config.enableWorkflowWrites && config.encryptionKey.length < 32) blockers.push('ENCRYPTION_KEY must be at least 32 characters when workflow writes are enabled.');
    if (config.enableWorkflowWrites && config.auditHmacKey.length < 32) blockers.push('AUDIT_HMAC_KEY must be at least 32 characters when workflow writes are enabled.');
    if (config.notificationProvider === 'console') blockers.push('Console notifications are not permitted in production.');
  }

  if (!['disabled', 'console', 'twilio', 'email'].includes(config.notificationProvider)) {
    blockers.push(`Unsupported NOTIFICATION_PROVIDER: ${config.notificationProvider}`);
  }
  if (!['disabled', 'manual'].includes(config.paymentProvider)) {
    blockers.push(`Unsupported PAYMENT_PROVIDER: ${config.paymentProvider}`);
  }
  if (config.enableWorkflowWrites && config.paymentProvider === 'disabled') {
    warnings.push('Workflow writes are enabled while payments are disabled; grants can progress only to acceptance/approval workflows.');
  }
  if (config.craStatusMaxAgeHours > 72) warnings.push('CRA status verification age exceeds 72 hours; consider a tighter release-time verification window.');
  if (config.retentionDays < 2190) warnings.push('Retention is under six years; verify CRA books-and-records requirements for each record class before production use.');

  return { ready: blockers.length === 0, blockers, warnings };
}
