import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';
import { ROLES, PERMISSIONS, hasPermission, requireOrgPermission } from '../src/security/rbac.mjs';
import { GRANT_STATES, transitionGrant } from '../src/workflow/grant_lifecycle.mjs';
import { RECIPIENT_TYPES, classifyGrantReporting } from '../src/compliance/reporting.mjs';
import { DisabledPaymentAdapter, ManualPaymentAdapter } from '../src/integrations/payment.mjs';
import { encryptText, decryptText } from '../src/security/crypto.mjs';
import { isReleaseEligibleStatusCheck, normalizeCraObservedStatus } from '../src/compliance/status_verifier.mjs';
import { REQUIRED_SCHEMA_OBJECTS } from '../src/db/schema_readiness.mjs';

const analyst = { id: 'u-analyst', roles: [ROLES.FOUNDATION_ANALYST], organizationId: 'f-1' };
const approver = { id: 'u-approver', roles: [ROLES.FOUNDATION_APPROVER], organizationId: 'f-1' };
const recipient = { id: 'u-recipient', roles: [ROLES.RECIPIENT_ADMIN], organizationId: 'r-1' };
const payment = { id: 'u-payment', roles: [ROLES.PAYMENT_OPERATOR], organizationId: 'f-1' };

function baseGrant() {
  return { id: 'g-1', state: GRANT_STATES.DRAFT, foundationOrgId: 'f-1', recipientOrgId: 'r-1', amountCad: 25000, purpose: 'Food security', proposedBy: null, compliance: { decision: 'pending' } };
}

test('production config fails closed when workflow security dependencies are missing', () => {
  const config = loadRuntimeConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://example.ca', DATABASE_URL: 'postgres://db', ENABLE_WORKFLOW_WRITES: '1' });
  const result = assessReadiness(config);
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(' '), /OIDC_ISSUER/);
  assert.match(result.blockers.join(' '), /OIDC_AUDIENCE/);
  assert.match(result.blockers.join(' '), /ENCRYPTION_KEY/);
});

test('production config can be ready with writes disabled and persistence configured', () => {
  const config = loadRuntimeConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://example.ca', DATABASE_URL: 'postgres://db', ENABLE_WORKFLOW_WRITES: '0' });
  assert.equal(assessReadiness(config).ready, true);
});

test('twilio readiness requires credentials and encryption', () => {
  const config = loadRuntimeConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://example.ca', DATABASE_URL: 'postgres://db', NOTIFICATION_PROVIDER: 'twilio' });
  const result = assessReadiness(config);
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(' '), /TWILIO_ACCOUNT_SID/);
  assert.match(result.blockers.join(' '), /ENCRYPTION_KEY/);
});

test('rbac separates proposal, approval, recipient consent and payment permissions', () => {
  assert.equal(hasPermission(analyst.roles, PERMISSIONS.PROPOSE_GRANT), true);
  assert.equal(hasPermission(analyst.roles, PERMISSIONS.APPROVE_GRANT), false);
  assert.equal(hasPermission(recipient.roles, PERMISSIONS.ACCEPT_GRANT), true);
  assert.equal(hasPermission(payment.roles, PERMISSIONS.AUTHORIZE_PAYMENT), true);
});

test('recipient funding permissions stay with recipient administrators', () => {
  assert.equal(hasPermission(recipient.roles, PERMISSIONS.MANAGE_RECIPIENT_FUNDING), true);
  assert.equal(hasPermission(recipient.roles, PERMISSIONS.SUBMIT_RECIPIENT_APPLICATION), true);
  assert.equal(hasPermission(analyst.roles, PERMISSIONS.MANAGE_RECIPIENT_FUNDING), false);
  assert.equal(hasPermission(analyst.roles, PERMISSIONS.SUBMIT_RECIPIENT_APPLICATION), false);
});

test('database readiness requires the recipient funding workspace', () => {
  for (const table of [
    'recipient_funding_profiles',
    'recipient_funding_requests',
    'grant_applications',
    'grant_application_events',
    'recipient_funding_operations'
  ]) assert.equal(REQUIRED_SCHEMA_OBJECTS.includes(table), true, `missing required schema table ${table}`);
});

test('organization-scoped roles do not leak between foundations', () => {
  const actor = { id: 'u', roles: [], memberships: [{ organizationId: 'f-1', role: ROLES.FOUNDATION_APPROVER }] };
  assert.equal(requireOrgPermission(actor, 'f-1', PERMISSIONS.APPROVE_GRANT), true);
  assert.throws(() => requireOrgPermission(actor, 'f-2', PERMISSIONS.APPROVE_GRANT), /lacks permission/);
});

test('grant lifecycle enforces separation of duties, offered terms and recipient consent', () => {
  let grant = transitionGrant(baseGrant(), GRANT_STATES.PROPOSED, analyst, { idempotencyKey: 'evt-1' });
  grant.proposedBy = analyst.id;
  assert.throws(() => transitionGrant(grant, GRANT_STATES.APPROVED, analyst), /lacks permission|Separation/);
  grant = transitionGrant(grant, GRANT_STATES.APPROVED, approver, { idempotencyKey: 'evt-2' });
  assert.throws(() => transitionGrant(grant, GRANT_STATES.OFFERED, approver, { idempotencyKey: 'evt-3' }), /termsVersion/);
  grant = transitionGrant(grant, GRANT_STATES.OFFERED, approver, { idempotencyKey: 'evt-3', termsVersion: 'v1', termsText: 'Unrestricted operating support terms.' });
  grant.termsVersion = 'v1';
  assert.throws(() => transitionGrant(grant, GRANT_STATES.ACCEPTED, recipient, { acceptedTerms: true, termsVersion: 'v2' }), /currently offered terms/);
  grant = transitionGrant(grant, GRANT_STATES.ACCEPTED, recipient, { acceptedTerms: true, termsVersion: 'v1', idempotencyKey: 'evt-4' });
  assert.equal(grant.state, GRANT_STATES.ACCEPTED);
});

test('payment authorization requires fresh authoritative recipient status and compliance approval', () => {
  let grant = { ...baseGrant(), state: GRANT_STATES.ACCEPTED, compliance: { decision: 'approved' }, recipientStatus: { status: 'eligible', assuranceLevel: 'authoritative', verifiedAt: '2026-08-16T10:00:00.000Z' } };
  grant = transitionGrant(grant, GRANT_STATES.PAYMENT_AUTHORIZED, payment, { idempotencyKey: 'evt-5' }, { now: new Date('2026-08-16T11:00:00.000Z'), maxStatusAgeHours: 24 });
  assert.equal(grant.state, GRANT_STATES.PAYMENT_AUTHORIZED);
  const screeningOnly = { ...grant, state: GRANT_STATES.ACCEPTED, recipientStatus: { status: 'eligible', assuranceLevel: 'screening', verifiedAt: '2026-08-16T10:00:00.000Z' } };
  assert.throws(() => transitionGrant(screeningOnly, GRANT_STATES.PAYMENT_AUTHORIZED, payment, {}, { now: new Date('2026-08-16T11:00:00.000Z') }), /authoritative/);
});

test('CRA observed statuses map conservatively for release gating', () => {
  assert.deepEqual(normalizeCraObservedStatus('registered'), { status: 'eligible', assuranceLevel: 'authoritative' });
  assert.equal(normalizeCraObservedStatus('suspended').status, 'ineligible');
  assert.equal(normalizeCraObservedStatus('penalized').status, 'needs_review');
  assert.equal(isReleaseEligibleStatusCheck({ status: 'eligible', assuranceLevel: 'screening', verifiedAt: new Date().toISOString() }), false);
});

test('non-qualified donee reporting threshold is aggregate per recipient for fiscal period', () => {
  const grants = [{ recipientOrgId: 'r-x', amountCad: 3000 }, { recipientOrgId: 'r-x', amountCad: 2500 }, { recipientOrgId: 'r-y', amountCad: 10000 }];
  const result = classifyGrantReporting({ recipientType: RECIPIENT_TYPES.NON_QUALIFIED_DONEE, recipientOrgId: 'r-x', fiscalYearGrants: grants });
  assert.equal(result.aggregateCad, 5500);
  assert.equal(result.t1441Required, true);
});

test('qualified donee reporting never routes through T1441', () => {
  const result = classifyGrantReporting({ recipientType: RECIPIENT_TYPES.QUALIFIED_DONEE, recipientOrgId: 'r-q', fiscalYearGrants: [{ recipientOrgId: 'r-q', amountCad: 20000 }] });
  assert.equal(result.t1441Required, false);
  assert.equal(result.route, 'qualified_donee_reporting');
});

test('private notification destinations round-trip through authenticated encryption', () => {
  const key = 'k'.repeat(40);
  const encrypted = encryptText('+15145550123', key);
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(decryptText(encrypted, key), '+15145550123');
  assert.throws(() => decryptText(encrypted, 'x'.repeat(40)));
});

test('payment adapters cannot move money implicitly', async () => {
  const disabled = new DisabledPaymentAdapter();
  assert.equal((await disabled.authorize()).authorized, false);
  const manual = new ManualPaymentAdapter();
  const auth = await manual.authorize({ grantId: 'g-1', amountCad: 10000 });
  assert.equal(auth.status, 'manual_external_execution_required');
  const recorded = await manual.recordExternalPayment({ grantId: 'g-1', externalPaymentReference: 'BANK-123' });
  assert.equal(recorded.moneyMovedByThisAdapter, false);
});
