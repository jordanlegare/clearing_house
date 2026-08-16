import { z } from 'zod';
import { ROLES } from '../security/rbac.mjs';
import { prepareNqdDiligence, getNqdDiligence, approveNqdDiligence, recordBankingVerification, createManualPaymentIntent } from '../workflow/runtime_extensions.mjs';
import { registerPortfolioTools } from './portfolio_tools.mjs';
import { registerPolicyTools } from './policy_tools.mjs';
import { registerDqTools } from './dq_tools.mjs';
import { registerReviewBundleTools } from './review_tools.mjs';
import { registerOfferBatchTools } from './offer_tools.mjs';
import { registerOpsTools } from './ops_tools.mjs';
import { registerStatusVerificationTools } from './status_tools.mjs';
import { registerFiscalReportingTools } from './reporting_tools.mjs';
import { getCraPublicEvidence } from '../status/cra-evidence.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const write = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const openRead = { readOnlyHint: true, openWorldHint: true, destructiveHint: false };
const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const boundedEvidence = z.record(z.union([z.string().max(5_000), z.number(), z.boolean(), z.null()])).refine(value => Object.keys(value).length <= 50, 'evidence has too many fields');

function result(message, data = {}) {
  return { structuredContent: data, content: [{ type: 'text', text: message }] };
}

export function registerWorkflowTools(server, { service, actor }) {
  server.registerTool('workflow_whoami', {
    title: 'Show clearing-house identity and roles',
    description: 'Return the authenticated user, global roles, organization memberships and OAuth scopes used for workflow authorization.',
    inputSchema: {}, annotations: readOnly
  }, async () => result('Returned the current workflow identity.', { actor: service.whoami(actor) }));

  server.registerTool('list_grants', {
    title: 'List accessible grant records',
    description: 'List grant workflow records visible through the authenticated user’s organization memberships.',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) }, annotations: readOnly
  }, async args => result('Returned accessible grant records.', { grants: await service.listGrants(actor, args) }));

  server.registerTool('get_grant', {
    title: 'Get grant workflow record',
    description: 'Return one grant if the authenticated user has access through the foundation or recipient organization.',
    inputSchema: { grantId: uuid }, annotations: readOnly
  }, async args => result('Returned grant workflow record.', { grant: await service.getGrant(actor, args.grantId) }));

  server.registerTool('claim_recipient_organization', {
    title: 'Claim registered charity organization',
    description: 'Create a pending claim to administer a registered charity found in the loaded T3010 dataset. The claim grants no access until independently verified by a system administrator.',
    inputSchema: { businessNumber: z.string().min(9).max(20), evidence: boundedEvidence.default({}), idempotencyKey }, annotations: consequential
  }, async args => result('Created or returned the pending organization claim. No organization access was granted yet.', { claim: await service.claimRecipientOrganization(actor, args) }));

  server.registerTool('claim_foundation_organization', {
    title: 'Claim foundation organization',
    description: 'Create a pending claim to administer a foundation found in the loaded T3010 dataset. The claim grants no access until independently verified by a system administrator.',
    inputSchema: { businessNumber: z.string().min(9).max(20), evidence: boundedEvidence.default({}), idempotencyKey }, annotations: consequential
  }, async args => result('Created or returned the pending foundation claim. No foundation access was granted yet.', { claim: await service.claimFoundationOrganization(actor, args) }));

  server.registerTool('verify_organization_claim', {
    title: 'Verify organization claim',
    description: 'System-admin action to approve or reject a recipient or foundation claim after independent identity/authority verification. Approval grants only the role requested by the claim.',
    inputSchema: {
      claimId: uuid,
      approved: z.boolean(),
      verificationMethod: z.string().min(3).max(200),
      evidence: boundedEvidence.default({}),
      idempotencyKey
    }, annotations: consequential
  }, async args => result(args.approved ? 'Verified organization claim and granted the claim role.' : 'Rejected organization claim.', { claim: await service.verifyRecipientClaim(actor, args) }));

  server.registerTool('grant_organization_role', {
    title: 'Grant organization workflow role',
    description: 'System-admin action to grant an organization-scoped foundation/compliance/recipient/payment/auditor role to a user who has already authenticated. Use only after independent authority verification.',
    inputSchema: {
      userSubject: z.string().min(1).max(500), organizationId: uuid,
      role: z.enum(['foundation_analyst','foundation_approver','compliance_reviewer','recipient_admin','payment_operator','auditor']),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Granted organization-scoped workflow role.', { membership: await service.grantOrganizationRole(actor, args) }));

  server.registerTool('create_grant', {
    title: 'Create grant draft',
    description: 'Create an idempotent grant draft for a foundation and recipient. This does not approve, offer, notify, or move money.',
    inputSchema: {
      foundationOrgId: uuid,
      recipientOrgId: uuid,
      amountCad: z.number().positive().max(10_000_000_000),
      purpose: z.string().min(3).max(10_000),
      idempotencyKey
    }, annotations: write
  }, async args => result('Created or returned the grant draft. No award has been made.', { grant: await service.createGrant(actor, args) }));

  server.registerTool('propose_grant', {
    title: 'Propose grant',
    description: 'Move a grant draft to proposed state. A separate authorized approver is still required.',
    inputSchema: { grantId: uuid, idempotencyKey }, annotations: write
  }, async args => result('Grant moved to proposed state.', { grant: await service.proposeGrant(actor, args) }));

  server.registerTool('approve_grant', {
    title: 'Approve grant',
    description: 'Approve a proposed grant. Separation of duties prevents the proposer from approving the same grant.',
    inputSchema: { grantId: uuid, idempotencyKey }, annotations: consequential
  }, async args => result('Grant approved. It has not yet been offered to or accepted by the recipient.', { grant: await service.approveGrant(actor, args) }));

  server.registerTool('offer_grant', {
    title: 'Offer approved grant',
    description: 'Offer an approved grant under a specific terms version. Optional email/SMS/voice notification is queued through the configured provider; this action does not transfer funds.',
    inputSchema: {
      grantId: uuid,
      termsVersion: z.string().min(1).max(100),
      termsText: z.string().min(10).max(50_000),
      notificationChannel: z.enum(['none','email','sms','voice']).default('none'),
      notificationRecipient: z.string().min(3).max(254).optional(),
      idempotencyKey
    }, annotations: consequential
  }, async args => { const offered = await service.offerGrant(actor, args); return result('Grant offered under the supplied terms. Any selected notification was queued; recipient acceptance is still required.', offered); });

  server.registerTool('accept_grant', {
    title: 'Accept grant offer',
    description: 'Recipient-admin action to explicitly accept the currently offered grant terms. This does not authorize payment.',
    inputSchema: { grantId: uuid, termsVersion: z.string().min(1).max(100), idempotencyKey }, annotations: consequential
  }, async args => result('Recipient accepted the grant terms. Payment still requires current status verification, compliance approval and payment authorization.', { grant: await service.acceptGrant(actor, args) }));

  server.registerTool('decline_grant', {
    title: 'Decline grant offer',
    description: 'Recipient-admin action to decline an offered grant. This is a terminal workflow action.',
    inputSchema: { grantId: uuid, reason: z.string().max(5_000).default(''), idempotencyKey }, annotations: consequential
  }, async args => result('Recipient declined the grant.', { grant: await service.declineGrant(actor, args) }));

  server.registerTool('check_cra_public_evidence', {
    title: 'Check CRA public revocation evidence',
    description: 'Check CRA’s published revocations page for the supplied charity BN and return evidence only. Absence from the page is not proof of current eligibility and cannot satisfy the payment release gate.',
    inputSchema: { businessNumber: z.string().min(9).max(20) }, annotations: openRead
  }, async args => result('Checked CRA public revocation evidence. This is not an eligibility determination.', { evidence: await getCraPublicEvidence(service, args) }));

  server.registerTool('record_cra_status_verification', {
    title: 'Record CRA charity-status verification',
    description: 'Compliance action to record a human-observed current status from CRA’s List of Charities. Annual T3010 data alone is not accepted as release-time status verification.',
    inputSchema: {
      grantId: uuid,
      observedStatus: z.enum(['registered','revoked','annulled','suspended','penalized','unknown']),
      verifiedAt: z.string().datetime().optional(),
      evidence: boundedEvidence.default({}),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Recorded authoritative CRA status observation for the grant recipient.', { statusCheck: await service.recordCraStatusVerification(actor, args) }));

  server.registerTool('prepare_nqd_diligence', {
    title: 'Prepare non-qualified-donee diligence',
    description: 'Prepare a proportional diligence assessment for a non-qualified-donee grant. A different compliance reviewer must approve the assessment before grant compliance can be approved.',
    inputSchema: {
      grantId: uuid,
      charitablePurposeAlignment: z.string().min(5).max(20_000),
      activityDescription: z.string().min(5).max(20_000),
      activityLocation: z.string().max(2_000).default(''),
      durationMonths: z.number().int().min(1).max(120).default(12),
      relationshipExperience: z.enum(['none','some','extensive']).default('none'),
      researchSummary: z.string().max(20_000).default(''),
      writtenAgreement: z.boolean().default(true),
      reportingPlan: z.string().min(3).max(5_000).default('final_report'),
      periodicTransfers: z.boolean().default(false),
      separateLedger: z.boolean().default(true),
      notes: z.string().max(20_000).default(''),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Prepared proportional non-qualified-donee diligence. Separate compliance approval is still required.', { diligence: await prepareNqdDiligence(service, actor, args) }));

  server.registerTool('get_nqd_diligence', {
    title: 'Get non-qualified-donee diligence',
    description: 'Read the diligence record for an accessible grant.',
    inputSchema: { grantId: uuid }, annotations: readOnly
  }, async args => result('Returned non-qualified-donee diligence.', { diligence: await getNqdDiligence(service, actor, args) }));

  server.registerTool('approve_nqd_diligence', {
    title: 'Approve non-qualified-donee diligence',
    description: 'Compliance-reviewer action to approve a non-qualified-donee diligence record. The reviewer cannot be the actor who prepared the same record.',
    inputSchema: { grantId: uuid, idempotencyKey }, annotations: consequential
  }, async args => result('Approved non-qualified-donee diligence.', { diligence: await approveNqdDiligence(service, actor, args) }));

  server.registerTool('review_grant_compliance', {
    title: 'Review grant compliance',
    description: 'Record an independent compliance decision and rationale before payment authorization. Non-qualified-donee grants cannot be approved until separately approved diligence exists.',
    inputSchema: {
      grantId: uuid,
      decision: z.enum(['approved','blocked','needs_review']),
      rationale: z.string().min(5).max(20_000),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Recorded grant compliance review.', { review: await service.reviewCompliance(actor, args) }));

  server.registerTool('record_banking_verification', {
    title: 'Record external banking verification',
    description: 'Record an external banking-verification status/reference for an accepted grant. The reference is encrypted; bank account/card coordinates must not be supplied.',
    inputSchema: {
      grantId: uuid,
      status: z.enum(['verified','needs_review','failed','expired']),
      externalReference: z.string().min(3).max(2_000),
      evidence: boundedEvidence.default({}),
      expiresAt: z.string().datetime().optional(),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Recorded external banking-verification evidence. No bank credentials or transfer instructions were stored.', { bankingVerification: await recordBankingVerification(service, actor, args) }));

  server.registerTool('create_manual_payment_intent', {
    title: 'Create manual payment intent',
    description: 'Payment-operator action to create the manual payment intent after external banking verification. A different payment operator must later authorize it; this tool cannot move money.',
    inputSchema: { grantId: uuid, idempotencyKey }, annotations: consequential
  }, async args => result('Created the manual payment intent for separate authorization. No bank transfer was executed.', { paymentIntent: await createManualPaymentIntent(service, actor, args) }));

  server.registerTool('authorize_manual_payment', {
    title: 'Authorize manual payment',
    description: 'Authorize a manual/external payment only after recipient acceptance, fresh authoritative CRA status verification, compliance approval, verified external banking evidence, and a payment intent created by a different operator. This tool cannot execute a bank transfer.',
    inputSchema: { grantId: uuid, idempotencyKey }, annotations: consequential
  }, async args => result('Manual payment was authorized for external execution. No bank transfer was executed by ChatGPT.', { grant: await service.authorizeManualPayment(actor, args) }));

  server.registerTool('record_manual_payment', {
    title: 'Record externally executed payment',
    description: 'Record the external payment reference after an authorized payment was executed outside ChatGPT. This tool cannot initiate or modify the bank transfer.',
    inputSchema: {
      grantId: uuid,
      externalPaymentReference: z.string().min(3).max(500),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Recorded the externally executed payment reference.', { grant: await service.recordManualPayment(actor, args) }));

  server.registerTool('prepare_reporting_record', {
    title: 'Prepare CRA reporting record',
    description: 'Prepare a reviewable T3010/T1441 routing record using paid grants in the specified foundation fiscal period. The output is not filed with CRA automatically.',
    inputSchema: {
      grantId: uuid,
      fiscalYear: z.number().int().min(2000).max(2100),
      fiscalPeriodStart: z.string().date(),
      fiscalPeriodEnd: z.string().date(),
      t3010Version: z.string().max(100).optional(),
      idempotencyKey
    }, annotations: write
  }, async args => result('Prepared a CRA reporting record for review. Nothing was filed with CRA.', { reportingRecord: await service.prepareReportingRecord(actor, args) }));

  server.registerTool('mark_grant_reported', {
    title: 'Mark grant reported',
    description: 'Record an external CRA submission reference and mark the paid grant reported. This records that the operator submitted the reporting package; it does not claim CRA accepted or validated the return.',
    inputSchema: { grantId: uuid, reportingRecordId: uuid, submissionReference: z.string().min(3).max(500), idempotencyKey }, annotations: consequential
  }, async args => result('Marked grant reported in the clearing-house workflow.', { grant: await service.markGrantReported(actor, args) }));

  registerPortfolioTools(server, { service, actor });
  registerPolicyTools(server, { service, actor });
  registerDqTools(server, { service, actor });
  registerReviewBundleTools(server, { service, actor });
  registerOfferBatchTools(server, { service, actor });
  registerOpsTools(server, { service, actor });
  registerStatusVerificationTools(server, { service, actor });
  registerFiscalReportingTools(server, { repository: service.repository, actor });
}
