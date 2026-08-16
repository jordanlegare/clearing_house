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
    recipientPortalEnabled: bool(env.RECIPIENT_PORTAL_ENABLED, false),
    recipientPortalBaseUrl: env.RECIPIENT_PORTAL_BASE_URL || '',
    recipientPortalPort: positiveInt(env.RECIPIENT_PORTAL_PORT, 3001),
    offerTokenTtlHours: positiveInt(env.OFFER_TOKEN_TTL_HOURS, 168),
    databaseUrl: env.DATABASE_URL || '',
    oidcIssuer: env.OIDC_ISSUER || '',
    oidcClientId: env.OIDC_CLIENT_ID || '',
    oidcAudience: env.OIDC_AUDIENCE || '',
    encryptionKey: env.ENCRYPTION_KEY || '',
    auditHmacKey: env.AUDIT_HMAC_KEY || '',
    notificationProvider: env.NOTIFICATION_PROVIDER || 'disabled',
    emailProvider: env.EMAIL_PROVIDER || 'disabled',
    paymentProvider: env.PAYMENT_PROVIDER || 'disabled',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFromNumber: env.TWILIO_FROM_NUMBER || '',
    resendApiKey: env.RESEND_API_KEY || '',
    resendFromEmail: env.RESEND_FROM_EMAIL || '',
    enableWorkflowWrites: bool(env.ENABLE_WORKFLOW_WRITES, false),
    enableT3010Sync: bool(env.ENABLE_T3010_SYNC, false),
    automationEnabled: bool(env.AUTOMATION_ENABLED, false),
    automatedPortfoliosEnabled: bool(env.AUTOMATED_PORTFOLIOS_ENABLED, false),
    websiteContactEnrichmentEnabled: bool(env.WEBSITE_CONTACT_ENRICHMENT_ENABLED, false),
    websiteContactTimeoutMs: positiveInt(env.WEBSITE_CONTACT_TIMEOUT_MS, 5000),
    websiteContactMaxPages: positiveInt(env.WEBSITE_CONTACT_MAX_PAGES, 4),
    websiteContactMaxBytes: positiveInt(env.WEBSITE_CONTACT_MAX_BYTES, 524288),
    allocationPolicyPollSeconds: positiveInt(env.ALLOCATION_POLICY_POLL_SECONDS, 300),
    allocationPolicyBatchSize: positiveInt(env.ALLOCATION_POLICY_BATCH_SIZE, 10),
    craStatusMaxAgeHours: positiveInt(env.CRA_STATUS_MAX_AGE_HOURS, 24),
    retentionDays: positiveInt(env.RETENTION_DAYS, 2555),
    notificationBatchSize: positiveInt(env.NOTIFICATION_BATCH_SIZE, 25),
    notificationPollSeconds: positiveInt(env.NOTIFICATION_POLL_SECONDS, 30),
    automationPollSeconds: positiveInt(env.AUTOMATION_POLL_SECONDS, 10),
    automationLeaseSeconds: positiveInt(env.AUTOMATION_LEASE_SECONDS, 300),
    t3010SyncIntervalHours: positiveInt(env.T3010_SYNC_INTERVAL_HOURS, 24),
    t3010AutoReloadSeconds: positiveInt(env.T3010_AUTO_RELOAD_SECONDS, 300),
    requireSeparationOfDuties: bool(env.REQUIRE_SEPARATION_OF_DUTIES, true)
  };
}

export function assessReadiness(config) {
  const blockers = [];
  const warnings = [];
  const phoneNotificationsEnabled = config.notificationProvider !== 'disabled';
  const emailNotificationsEnabled = config.emailProvider !== 'disabled';
  const anyNotificationsEnabled = phoneNotificationsEnabled || emailNotificationsEnabled;

  if (config.production) {
    if (!config.publicBaseUrl.startsWith('https://')) blockers.push('PUBLIC_BASE_URL must use HTTPS in production.');
    if (!config.databaseUrl) blockers.push('DATABASE_URL is required in production.');
    if (config.enableWorkflowWrites && !config.oidcIssuer) blockers.push('OIDC_ISSUER is required when workflow writes are enabled.');
    if (config.enableWorkflowWrites && !config.oidcClientId) blockers.push('OIDC_CLIENT_ID is required when workflow writes are enabled.');
    if (config.enableWorkflowWrites && !config.oidcAudience) blockers.push('OIDC_AUDIENCE is required when workflow writes are enabled.');
    if (config.enableWorkflowWrites && config.encryptionKey.length < 32) blockers.push('ENCRYPTION_KEY must be at least 32 characters when workflow writes are enabled.');
    if (config.enableWorkflowWrites && config.auditHmacKey.length < 32) blockers.push('AUDIT_HMAC_KEY must be at least 32 characters when workflow writes are enabled.');
    if (config.recipientPortalEnabled && !config.recipientPortalBaseUrl.startsWith('https://')) blockers.push('RECIPIENT_PORTAL_BASE_URL must use HTTPS when the recipient portal is enabled in production.');
    if (config.notificationProvider === 'console') blockers.push('Console phone notifications are not permitted in production.');
    if (config.emailProvider === 'console') blockers.push('Console email notifications are not permitted in production.');
  }

  if (config.automationEnabled && !config.databaseUrl) blockers.push('DATABASE_URL is required when autonomous operations are enabled.');
  if (config.automatedPortfoliosEnabled && !config.automationEnabled) blockers.push('AUTOMATION_ENABLED must be enabled when automated allocation policies are enabled.');
  if (config.automatedPortfoliosEnabled && !config.enableWorkflowWrites) blockers.push('ENABLE_WORKFLOW_WRITES must be enabled when automated allocation policies can materialize drafts.');
  if (config.automatedPortfoliosEnabled && !config.databaseUrl) blockers.push('DATABASE_URL is required when automated allocation policies are enabled.');
  if (config.automatedPortfoliosEnabled && config.auditHmacKey.length < 32) blockers.push('AUDIT_HMAC_KEY must be at least 32 characters when automated allocation policies are enabled.');
  if (config.allocationPolicyPollSeconds < 60) blockers.push('ALLOCATION_POLICY_POLL_SECONDS must be at least 60 seconds.');
  if (config.allocationPolicyBatchSize > 100) blockers.push('ALLOCATION_POLICY_BATCH_SIZE cannot exceed 100.');
  if (config.recipientPortalEnabled && !config.databaseUrl) blockers.push('DATABASE_URL is required when the recipient portal is enabled.');
  if (config.recipientPortalEnabled && config.auditHmacKey.length < 32) blockers.push('AUDIT_HMAC_KEY must be at least 32 characters when the recipient portal is enabled.');
  if (config.recipientPortalEnabled && config.encryptionKey.length < 32) blockers.push('ENCRYPTION_KEY must be at least 32 characters when the recipient portal is enabled.');
  if (config.recipientPortalEnabled && !config.recipientPortalBaseUrl) blockers.push('RECIPIENT_PORTAL_BASE_URL is required when the recipient portal is enabled.');
  if (config.offerTokenTtlHours > 720) blockers.push('OFFER_TOKEN_TTL_HOURS cannot exceed 720 hours.');
  if (!['disabled', 'console', 'twilio'].includes(config.notificationProvider)) blockers.push(`Unsupported NOTIFICATION_PROVIDER: ${config.notificationProvider}`);
  if (!['disabled', 'console', 'resend'].includes(config.emailProvider)) blockers.push(`Unsupported EMAIL_PROVIDER: ${config.emailProvider}`);
  if (!['disabled', 'manual'].includes(config.paymentProvider)) blockers.push(`Unsupported PAYMENT_PROVIDER: ${config.paymentProvider}`);
  if (config.notificationProvider === 'twilio') {
    if (!config.twilioAccountSid) blockers.push('TWILIO_ACCOUNT_SID is required for Twilio notifications.');
    if (!config.twilioAuthToken) blockers.push('TWILIO_AUTH_TOKEN is required for Twilio notifications.');
    if (!config.twilioFromNumber) blockers.push('TWILIO_FROM_NUMBER is required for Twilio notifications.');
    if (config.encryptionKey.length < 32) blockers.push('ENCRYPTION_KEY is required to encrypt notification recipients.');
  }
  if (config.emailProvider === 'resend') {
    if (!config.resendApiKey) blockers.push('RESEND_API_KEY is required for Resend email notifications.');
    if (!config.resendFromEmail) blockers.push('RESEND_FROM_EMAIL is required for Resend email notifications.');
    if (config.encryptionKey.length < 32) blockers.push('ENCRYPTION_KEY is required to encrypt email recipients.');
  }
  if (config.websiteContactEnrichmentEnabled) {
    if (!config.automationEnabled) blockers.push('AUTOMATION_ENABLED must be enabled when website contact enrichment is enabled.');
    if (!config.enableWorkflowWrites) blockers.push('ENABLE_WORKFLOW_WRITES must be enabled when website contact enrichment is enabled.');
    if (!config.recipientPortalEnabled) blockers.push('RECIPIENT_PORTAL_ENABLED must be enabled when website contact enrichment is enabled.');
    if (!anyNotificationsEnabled) blockers.push('At least one phone or email notification provider must be enabled when website contact enrichment is enabled so candidates can prove channel control.');
    if (config.websiteContactTimeoutMs < 1000 || config.websiteContactTimeoutMs > 10000) blockers.push('WEBSITE_CONTACT_TIMEOUT_MS must be between 1000 and 10000 milliseconds.');
    if (config.websiteContactMaxPages > 5) blockers.push('WEBSITE_CONTACT_MAX_PAGES cannot exceed 5.');
    if (config.websiteContactMaxBytes > 1048576) blockers.push('WEBSITE_CONTACT_MAX_BYTES cannot exceed 1048576 bytes.');
  }
  if (config.enableWorkflowWrites && config.paymentProvider === 'disabled') warnings.push('Workflow writes are enabled while payments are disabled; grants can progress only to acceptance/compliance workflows.');
  if (config.enableWorkflowWrites && !anyNotificationsEnabled) warnings.push('Workflow writes are enabled while notifications are disabled; offers must be surfaced through another recipient channel.');
  if (config.enableWorkflowWrites && anyNotificationsEnabled && !config.recipientPortalEnabled) warnings.push('Recipient notifications are enabled without the no-account recipient portal; messages cannot include secure one-click offer links.');
  if (config.automationEnabled && !anyNotificationsEnabled) warnings.push('Autonomous operations are enabled but recipient notifications are disabled.');
  if (config.automatedPortfoliosEnabled && !config.enableT3010Sync) warnings.push('Automated allocation policies are enabled while T3010 auto-sync is off; policies will use whatever local public-data snapshot is loaded.');
  if (config.websiteContactEnrichmentEnabled && !config.enableT3010Sync) warnings.push('Website contact enrichment is enabled while T3010 auto-sync is off; website URLs may become stale.');
  if (config.enableT3010Sync && !config.automationEnabled) warnings.push('T3010 synchronization is enabled but autonomous operations are off; refreshes require a manual sync action.');
  if (config.craStatusMaxAgeHours > 72) warnings.push('CRA status verification age exceeds 72 hours; consider a tighter release-time verification window.');
  if (config.retentionDays < 2190) warnings.push('Retention is under six years; verify CRA books-and-records requirements for each record class before production use.');

  return { ready: blockers.length === 0, blockers, warnings };
}
