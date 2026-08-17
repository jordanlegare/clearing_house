import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { RecipientFundingWorkspace } from '../src/workflow/recipient_funding_workspace.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for recipient funding workspace DB smoke.');
const pool = createDatabasePool(databaseUrl);
const repository = new WorkflowRepository(pool, {
  auditHmacKey: process.env.AUDIT_HMAC_KEY || 'a'.repeat(40),
  encryptionKey: process.env.ENCRYPTION_KEY || 'e'.repeat(40)
});

try {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  let admin = await repository.upsertActorFromClaims({ subject: `funding-admin-${suffix}` });
  await pool.query('INSERT INTO user_global_roles (user_id,role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [admin.id, 'system_admin']);
  admin = await repository.upsertActorFromClaims({ subject: `funding-admin-${suffix}` });
  let claimant = await repository.upsertActorFromClaims({ subject: `funding-recipient-${suffix}`, email: `recipient-${suffix}@example.ca` });

  const claimArgs = {
    actor: claimant,
    legalName: `Neighbourhood Food Venture ${suffix}`,
    organizationType: 'non_qualified_donee',
    province: 'ON',
    evidence: { incorporationReference: `inc-${suffix}` },
    idempotencyKey: `venture-claim-${suffix}`
  };
  const [firstClaim, replayedClaim] = await Promise.all([
    repository.createVentureOrganizationClaim(claimArgs),
    repository.createVentureOrganizationClaim(claimArgs)
  ]);
  assert.equal(replayedClaim.id, firstClaim.id);
  assert.equal(firstClaim.status, 'pending');

  await repository.verifyRecipientClaim({
    actor: admin,
    claimId: firstClaim.id,
    approved: true,
    verificationMethod: 'CI incorporation fixture',
    evidence: { verified: true },
    idempotencyKey: `venture-verify-${suffix}`
  });
  claimant = await repository.upsertActorFromClaims({ subject: `funding-recipient-${suffix}` });
  const recipientOrgId = claimant.memberships.find(item => item.role === 'recipient_admin').organizationId;

  const fakeT3010 = {
    foundationProfile(bn) {
      if (bn !== '123456789RR0001') return null;
      return {
        bn,
        name: 'Food Mobility Foundation',
        province: 'ON',
        designation: 'private_foundation',
        sourceYear: 2024,
        programDescriptions: ['Food security transportation equipment'],
        historicalQualifiedDoneeRows: [{ recipient: 'Community Food Centre' }]
      };
    },
    matchRecipientFoundations() {
      return {
        screeningOnly: true,
        warnings: ['Historical support evidence is not a current grant budget.'],
        matches: [{
          bn: '123456789RR0001',
          name: 'Food Mobility Foundation',
          province: 'ON',
          sourceYear: 2024,
          designation: 'private_foundation',
          supportSignalCad: 600000,
          score: 0.75,
          matchedTerms: ['food', 'security', 'transportation'],
          rationale: 'Shared filing-evidence terms: food, security, transportation',
          evidence: {
            supportingEvidence: [{
              sourceKind: 'charitable_program',
              sourceResourceId: 'ci-foundation-programs',
              sourceUrl: 'https://example.ca/ci-foundation-programs.csv',
              rowNumber: 1,
              excerpt: 'Food security transportation equipment',
              matchedTerms: ['food', 'security', 'transportation']
            }]
          }
        }]
      };
    }
  };
  const workspace = new RecipientFundingWorkspace({ repository, t3010Repository: fakeT3010 });

  const profile = await workspace.upsertProfile(claimant, {
    recipientOrgId,
    mission: 'Improve food security through recovered-food distribution.',
    activities: ['Community meals', 'Food rescue'],
    populations: ['Low-income households'],
    geography: ['Toronto'],
    outcomes: [{ name: 'Meals served', target: 12000 }],
    governance: { incorporated: true },
    financialSummary: { fiscalYear: 2025, revenueCad: 500000 },
    evidence: [{ label: '2025 annual report', reference: `report-${suffix}` }],
    idempotencyKey: `funding-profile-${suffix}`
  });
  assert.equal(profile.version, 1);

  const request = await workspace.createRequest(claimant, {
    recipientOrgId,
    title: 'Refrigerated truck',
    purpose: 'Purchase a refrigerated food rescue truck.',
    amountCad: 85000,
    objectives: ['Recover more surplus food'],
    activities: ['Purchase and deploy truck'],
    outcomes: [{ name: 'Food recovered kg', target: 200000 }],
    budget: [{ label: 'Truck', amountCad: 85000 }],
    geography: ['Toronto'],
    populations: ['Low-income households'],
    evidence: [{ label: 'Dealer quote', reference: `quote-${suffix}` }],
    idempotencyKey: `funding-request-${suffix}`
  });

  const otherOrgId = (await pool.query(`INSERT INTO organizations
    (legal_name,organization_type,province,public_profile)
    VALUES ($1,'other','ON','{}'::jsonb) RETURNING id`, [`Constraint Fixture ${suffix}`])).rows[0].id;
  const invalidApplication = [otherOrgId, request.id, claimant.id, `invalid-cross-org-${suffix}`];
  await assert.rejects(() => pool.query(`INSERT INTO grant_applications
    (recipient_org_id,funding_request_id,foundation_bn,foundation_name,status,package_snapshot,
     package_hash,readiness,created_by,updated_by,creation_idempotency_key)
    VALUES ($1,$2,'123456789RR0001','Invalid Cross-org Foundation','draft','{}'::jsonb,
      '${'0'.repeat(64)}','{}'::jsonb,$3,$3,$4)`, invalidApplication), /foreign key/i);
  await assert.rejects(() => pool.query(`INSERT INTO grant_applications
    (recipient_org_id,funding_request_id,foundation_bn,foundation_name,status,package_snapshot,
     package_hash,readiness,created_by,updated_by,creation_idempotency_key)
    VALUES ($1,$2,'123456789RR0001','Invalid Submitted Foundation','submitted','{}'::jsonb,
      '${'0'.repeat(64)}','{}'::jsonb,$3,$3,$4)`,
  [recipientOrgId, request.id, claimant.id, `invalid-submitted-${suffix}`]), /check constraint/i);
  await assert.rejects(() => pool.query(`INSERT INTO grant_applications
    (recipient_org_id,funding_request_id,foundation_bn,foundation_name,status,package_snapshot,
     package_hash,readiness,submission_channel,outcome_rationale,decided_at,
     created_by,updated_by,creation_idempotency_key)
    VALUES ($1,$2,'123456789RR0001','Invalid Withdrawn Foundation','withdrawn','{}'::jsonb,
      '${'0'.repeat(64)}','{}'::jsonb,'portal','Withdrawn',now(),$3,$3,$4)`,
  [recipientOrgId, request.id, claimant.id, `invalid-withdrawn-${suffix}`]), /check constraint/i);

  const grantsBefore = Number((await pool.query('SELECT count(*) AS n FROM grants')).rows[0].n);
  let application = await workspace.prepareApplication(claimant, {
    recipientOrgId,
    fundingRequestId: request.id,
    foundationBn: '123456789RR0001',
    idempotencyKey: `funding-application-${suffix}`
  });
  assert.equal(application.status, 'draft');
  assert.equal(application.readiness.ready, true);
  await assert.rejects(() => workspace.prepareApplication(claimant, {
    recipientOrgId,
    fundingRequestId: request.id,
    foundationBn: '123456789RR0001',
    province: 'BC',
    idempotencyKey: `funding-application-${suffix}`
  }), /different recipient-funding inputs/i);

  const updatedRequest = await workspace.updateRequest(claimant, {
    recipientOrgId,
    requestId: request.id,
    expectedVersion: request.version,
    title: request.title,
    purpose: `${request.purpose} Includes cold-chain safety equipment.`,
    amountCad: request.amountCad,
    objectives: request.objectives,
    activities: request.activities,
    outcomes: request.outcomes,
    budget: request.budget,
    geography: request.geography,
    populations: request.populations,
    evidence: request.evidence,
    idempotencyKey: `funding-request-update-${suffix}`
  });
  assert.equal(updatedRequest.version, 2);
  await assert.rejects(() => workspace.transitionApplication(claimant, {
    applicationId: application.id,
    nextStatus: 'ready',
    packageHash: application.packageHash,
    confirmation: 'MARK APPLICATION READY',
    idempotencyKey: `funding-stale-ready-${suffix}`
  }), /funding request changed/i);
  application = await workspace.transitionApplication(claimant, {
    applicationId: application.id,
    nextStatus: 'withdrawn',
    rationale: 'Source facts changed before readiness confirmation.',
    decidedAt: new Date().toISOString(),
    idempotencyKey: `funding-stale-withdraw-${suffix}`
  });
  application = await workspace.prepareApplication(claimant, {
    recipientOrgId,
    fundingRequestId: request.id,
    foundationBn: '123456789RR0001',
    idempotencyKey: `funding-application-current-${suffix}`
  });

  application = await workspace.transitionApplication(claimant, {
    applicationId: application.id,
    nextStatus: 'ready',
    packageHash: application.packageHash,
    confirmation: 'MARK APPLICATION READY',
    idempotencyKey: `funding-ready-${suffix}`
  });
  application = await workspace.transitionApplication(claimant, {
    applicationId: application.id,
    nextStatus: 'submitted',
    submissionChannel: 'foundation_portal',
    externalSubmissionReference: `foundation-portal-${suffix}`,
    submittedAt: new Date(Date.now() + 1_000).toISOString(),
    idempotencyKey: `funding-submit-${suffix}`
  });
  application = await workspace.transitionApplication(claimant, {
    applicationId: application.id,
    nextStatus: 'awarded',
    rationale: 'Foundation award letter received.',
    decidedAt: new Date(Date.now() + 2_000).toISOString(),
    idempotencyKey: `funding-outcome-${suffix}`
  });

  assert.equal(application.status, 'awarded');
  assert.equal(application.externalSubmissionReference, `foundation-portal-${suffix}`);
  const grantsAfter = Number((await pool.query('SELECT count(*) AS n FROM grants')).rows[0].n);
  assert.equal(grantsAfter, grantsBefore);
  const auditCount = Number((await pool.query(`SELECT count(*) AS n FROM audit_log
    WHERE organization_id=$1 AND action LIKE 'grant_application.%'`, [recipientOrgId])).rows[0].n);
  assert.ok(auditCount >= 4);

  console.log(JSON.stringify({
    ok: true,
    recipientOrgId,
    applicationId: application.id,
    status: application.status,
    externalSubmissionReference: application.externalSubmissionReference,
    grantRowsUnchanged: true,
    auditCount
  }, null, 2));
} finally {
  await pool.end();
}
