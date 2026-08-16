import assert from 'node:assert/strict';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { WorkflowService } from '../src/workflow/workflow_service.mjs';
import { createManualPaymentIntent, recordBankingVerification } from '../src/workflow/runtime_extensions.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for workflow DB smoke.');
const auditHmacKey = process.env.AUDIT_HMAC_KEY || 'a'.repeat(40);
const encryptionKey = process.env.ENCRYPTION_KEY || 'e'.repeat(40);
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, { auditHmacKey, encryptionKey });
const config = {
  paymentProvider: 'manual', notificationProvider: 'disabled', requireSeparationOfDuties: true,
  craStatusMaxAgeHours: 24, publicBaseUrl: 'https://clearing.example.ca'
};
const service = new WorkflowService({ repository, t3010Repository: null, config });

async function actor(subject, organizationId, role) {
  let user = await repository.upsertActorFromClaims({ subject, email: `${subject}@example.ca`, displayName: subject });
  await pool.query('INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [user.id, organizationId, role]);
  user = await repository.upsertActorFromClaims({ subject });
  return user;
}

try {
  const foundation = (await pool.query(`INSERT INTO organizations (legal_name, organization_type) VALUES ('Test Foundation','foundation') RETURNING *`)).rows[0];
  const recipient = (await pool.query(`INSERT INTO organizations (business_number, legal_name, organization_type) VALUES ('123456789RR0001','Test Charity','registered_charity') RETURNING *`)).rows[0];
  const analyst = await actor('analyst', foundation.id, 'foundation_analyst');
  const approver = await actor('approver', foundation.id, 'foundation_approver');
  const compliance = await actor('compliance', foundation.id, 'compliance_reviewer');
  const payCreator = await actor('payment-creator', foundation.id, 'payment_operator');
  const payAuthorizer = await actor('payment-authorizer', foundation.id, 'payment_operator');
  const recipientAdmin = await actor('recipient', recipient.id, 'recipient_admin');

  let grant = await service.createGrant(analyst, {
    foundationOrgId: foundation.id, recipientOrgId: recipient.id, amountCad: 25000,
    purpose: 'General operating support', idempotencyKey: 'db-smoke-create'
  });
  grant = await service.proposeGrant(analyst, { grantId: grant.id, idempotencyKey: 'db-smoke-propose' });
  grant = await service.approveGrant(approver, { grantId: grant.id, idempotencyKey: 'db-smoke-approve' });
  const offered = await service.offerGrant(approver, {
    grantId: grant.id, termsVersion: '2026-1', termsText: 'Unrestricted charitable operating support; recipient may decline.',
    notificationChannel: 'sms', notificationRecipient: '+15145550123', idempotencyKey: 'db-smoke-offer'
  });
  assert.equal(offered.grant.state, 'offered');
  assert.equal(offered.notification.recipient, '[encrypted]');
  grant = await service.acceptGrant(recipientAdmin, { grantId: grant.id, termsVersion: '2026-1', idempotencyKey: 'db-smoke-accept' });
  assert.equal(grant.state, 'accepted');

  await service.recordCraStatusVerification(compliance, {
    grantId: grant.id, observedStatus: 'registered', verifiedAt: new Date().toISOString(),
    evidence: { checkedBy: 'CI smoke' }, idempotencyKey: 'db-smoke-status'
  });
  await service.reviewCompliance(compliance, {
    grantId: grant.id, decision: 'approved', rationale: 'Qualified donee status recorded and grant purpose reviewed.', idempotencyKey: 'db-smoke-compliance'
  });

  const banking = await recordBankingVerification(service, payCreator, {
    grantId: grant.id,
    status: 'verified',
    externalReference: 'CI-BANKING-VERIFICATION-001',
    evidence: { provider: 'ci-fixture', scope: 'recipient-payout-destination' },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: 'db-smoke-banking'
  });
  assert.equal(banking.external_reference_encrypted, '[encrypted]');

  const intent = await createManualPaymentIntent(service, payCreator, {
    grantId: grant.id,
    idempotencyKey: 'db-smoke-payment-intent'
  });
  assert.equal(intent.status, 'created');
  assert.equal(intent.created_by, payCreator.id);

  await assert.rejects(
    () => service.authorizeManualPayment(payCreator, { grantId: grant.id, idempotencyKey: 'db-smoke-self-auth' }),
    /creator cannot authorize|different operator/i
  );

  grant = await service.authorizeManualPayment(payAuthorizer, { grantId: grant.id, idempotencyKey: 'db-smoke-auth-payment' });
  assert.equal(grant.state, 'payment_authorized');
  const paymentIntent = (await pool.query('SELECT created_by, authorized_by, status FROM payment_intents WHERE grant_id=$1', [grant.id])).rows[0];
  assert.equal(paymentIntent.created_by, payCreator.id);
  assert.equal(paymentIntent.authorized_by, payAuthorizer.id);
  assert.notEqual(paymentIntent.created_by, paymentIntent.authorized_by);

  grant = await service.recordManualPayment(payAuthorizer, { grantId: grant.id, externalPaymentReference: 'CI-BANK-REF-001', idempotencyKey: 'db-smoke-paid' });
  assert.equal(grant.state, 'paid');

  const now = new Date();
  const year = now.getUTCFullYear();
  const reporting = await service.prepareReportingRecord(approver, {
    grantId: grant.id, fiscalYear: year, fiscalPeriodStart: `${year}-01-01`, fiscalPeriodEnd: `${year}-12-31`,
    t3010Version: String(year), idempotencyKey: 'db-smoke-report'
  });
  assert.equal(reporting.t1441_required, false);
  grant = await service.markGrantReported(approver, { grantId: grant.id, reportingRecordId: reporting.id, submissionReference: 'CI-CRA-SUBMISSION-001', idempotencyKey: 'db-smoke-reported' });
  assert.equal(grant.state, 'reported');

  const rawNotification = (await pool.query('SELECT recipient, attempts, status FROM notification_outbox WHERE grant_id=$1', [grant.id])).rows[0];
  assert.match(rawNotification.recipient, /^enc:v1:/);
  assert.equal(rawNotification.status, 'queued');
  const rawBankingReference = (await pool.query('SELECT external_reference_encrypted FROM banking_verifications WHERE grant_id=$1', [grant.id])).rows[0].external_reference_encrypted;
  assert.match(rawBankingReference, /^enc:v1:/);
  assert.doesNotMatch(rawBankingReference, /CI-BANKING-VERIFICATION-001/);
  const auditCount = Number((await pool.query('SELECT count(*) AS n FROM audit_log')).rows[0].n);
  assert.ok(auditCount >= 12);

  console.log(JSON.stringify({ ok: true, grantId: grant.id, state: grant.state, reportingRecordId: reporting.id, auditCount }, null, 2));
} finally {
  await pool.end();
}
