import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';
import { ROLES, PERMISSIONS, hasPermission } from '../src/security/rbac.mjs';
import { GRANT_STATES, transitionGrant } from '../src/workflow/grant_lifecycle.mjs';
import { RECIPIENT_TYPES, classifyGrantReporting } from '../src/compliance/reporting.mjs';
import { DisabledPaymentAdapter, ManualPaymentAdapter } from '../src/integrations/payment.mjs';

const analyst = { id: 'u-analyst', roles: [ROLES.FOUNDATION_ANALYST], organizationId: 'f-1' };
const approver = { id: 'u-approver', roles: [ROLES.FOUNDATION_APPROVER], organizationId: 'f-1' };
const recipient = { id: 'u-recipient', roles: [ROLES.RECIPIENT_ADMIN], organizationId: 'r-1' };
const payment = { id: 'u-payment', roles: [ROLES.PAYMENT_OPERATOR] };

function baseGrant() {
  return { id: 'g-1', state: GRANT_STATES.DRAFT, foundationOrgId: 'f-1', recipientOrgId: 'r-1', amountCad: 25000, purpose: 'Food security', proposedBy: null, compliance: { decision: 'pending' } };
}

test('production config fails closed when workflow security dependencies are missing', () => {
  const config = loadRuntimeConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://example.ca', DATABASE_URL: 'postgres://db', ENABLE_WORKFLOW_WRITES: '1' });
  const result = assessReadiness(config);
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(' '), /OIDC_ISSUER/);
  assert.match(result.blockers.join(' '), /ENCRYPTION_KEY/);
});

test('production config can be ready with writes disabled and persistence configured', () => {
  const config = loadRuntimeConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://example.ca', DATABASE_URL: 'postgres://db', ENABLE_WORKFLOW_WRITES: '0' });
  const result = assessReadiness(config);
  assert.equal(result.ready, true);
});

test('rbac separates proposal, approval, recipient consent and payment permissions', () => {
  assert.equal(hasPermission(analyst.roles, PERMISSIONS.PROPOSE_GRANT), true);
  assert.equal(hasPermission(analyst.roles, PERMISSIONS.APPROVE_GRANT), false);
  assert.equal(hasPermission(recipient.roles, PERMISSIONS.ACCEPT_GRANT), true);
  assert.equal(hasPermission(payment.roles, PERMISSIONS.AUTHORIZE_PAYMENT), true);
});

test('grant lifecycle enforces separation of duties and recipient consent', () => {
  let grant = transitionGrant(baseGrant(), GRANT_STATES.PROPOSED, analyst, { idempotencyKey: 'evt-1' });
  grant.proposedBy = analyst.id;
  assert.throws(() => transitionGrant(grant, GRANT_STATES.APPROVED, analyst), /lacks permission|Separation/);
  grant = transitionGrant(grant, GRANT_STATES.APPROVED, approver, { idempotencyKey: 'evt-2' });
  grant = transitionGrant(grant, GRANT_STATES.OFFERED, approver, { idempotencyKey: 'evt-3' });
  assert.throws(() => transitionGrant(grant, GRANT_STATES.ACCEPTED, recipient, { acceptedTerms: false }), /explicitly accept/);
  grant = transitionGrant(grant, GRANT_STATES.ACCEPTED, recipient, { acceptedTerms: true, idempotencyKey: 'evt-4' });
  assert.equal(grant.state, GRANT_STATES.ACCEPTED);
});

test('payment authorization requires fresh recipient status and compliance approval', () => {
  let grant = { ...baseGrant(), state: GRANT_STATES.ACCEPTED, proposedBy: analyst.id, compliance: { decision: 'approved' }, recipientStatus: { status: 'eligible', verifiedAt: '2026-08-16T10:00:00.000Z' } };
  grant = transitionGrant(grant, GRANT_STATES.PAYMENT_AUTHORIZED, payment, { idempotencyKey: 'evt-5' }, { now: new Date('2026-08-16T11:00:00.000Z'), maxStatusAgeHours: 24 });
  assert.equal(grant.state, GRANT_STATES.PAYMENT_AUTHORIZED);
  const stale = { ...grant, state: GRANT_STATES.ACCEPTED, recipientStatus: { status: 'eligible', verifiedAt: '2026-08-10T10:00:00.000Z' } };
  assert.throws(() => transitionGrant(stale, GRANT_STATES.PAYMENT_AUTHORIZED, payment, {}, { now: new Date('2026-08-16T11:00:00.000Z') }), /Fresh eligible-recipient status/);
});

test('non-qualified donee reporting threshold is aggregate per recipient for fiscal period', () => {
  const grants = [
    { recipientOrgId: 'r-x', amountCad: 3000 },
    { recipientOrgId: 'r-x', amountCad: 2500 },
    { recipientOrgId: 'r-y', amountCad: 10000 }
  ];
  const result = classifyGrantReporting({ recipientType: RECIPIENT_TYPES.NON_QUALIFIED_DONEE, recipientOrgId: 'r-x', fiscalYearGrants: grants });
  assert.equal(result.aggregateCad, 5500);
  assert.equal(result.t1441Required, true);
  assert.equal(result.route, 't1441_individual_grant_reporting');
});

test('qualified donee reporting never routes through T1441', () => {
  const result = classifyGrantReporting({ recipientType: RECIPIENT_TYPES.QUALIFIED_DONEE, recipientOrgId: 'r-q', fiscalYearGrants: [{ recipientOrgId: 'r-q', amountCad: 20000 }] });
  assert.equal(result.t1441Required, false);
  assert.equal(result.route, 'qualified_donee_reporting');
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
