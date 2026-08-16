import { z } from 'zod';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const write = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };

function result(message, data = {}) {
  return { structuredContent: data, content: [{ type: 'text', text: message }] };
}

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const boundedEvidence = z.record(z.any()).refine(value => JSON.stringify(value).length <= 20_000, 'evidence exceeds 20KB');

export function registerWorkflowTools(server, { service, actor }) {
  server.registerTool('workflow_whoami', {
    title: 'Show workflow identity',
    description: 'Show the authenticated clearing-house user, global roles and organization-scoped memberships used for grant workflow authorization.',
    inputSchema: {}, annotations: readOnly
  }, async () => result('Returned authenticated workflow identity.', { actor: service.whoami(actor) }));

  server.registerTool('workflow_list_grants', {
    title: 'List accessible grants',
    description: 'List grants visible to the authenticated user through foundation or recipient organization memberships.',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) }, annotations: readOnly
  }, async args => result('Returned accessible grants.', { grants: await service.listGrants(actor, args) }));

  server.registerTool('workflow_get_grant', {
    title: 'Get grant workflow record',
    description: 'Fetch an authenticated grant workflow record, including current terms, compliance decision and authoritative recipient-status evidence when available.',
    inputSchema: { grantId: uuid }, annotations: readOnly
  }, async ({ grantId }) => result('Returned grant workflow record.', { grant: await service.getGrant(actor, grantId) }));

  server.registerTool('claim_recipient_organization', {
    title: 'Claim a registered charity profile',
    description: 'Create a pending claim linking the authenticated user to a registered-charity organization found in the loaded CRA T3010 dataset. Verification is still required before recipient-admin access is granted.',
    inputSchema: {
      businessNumber: z.string().min(9).max(20),
      evidence: boundedEvidence.default({}),
      idempotencyKey
    }, annotations: write
  }, async args => result('Created or returned the pending recipient-organization claim. No access was granted yet.', { claim: await service.claimRecipientOrganization(actor, args) }));

  server.registerTool('claim_foundation_organization', {
    title: 'Claim a foundation profile',
    description: 'Create a pending claim linking the authenticated user to a public/private foundation found in the loaded CRA T3010 data. A verified claim grants foundation_analyst only; approval/payment roles require a separate admin grant.',
    inputSchema: { businessNumber: z.string().min(9).max(20), evidence: boundedEvidence.default({}), idempotencyKey }, annotations: write
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
    description: 'Offer an approved grant under a specific terms version. This records the offer but does not itself transfer funds.',
    inputSchema: {
      grantId: uuid,
      termsVersion: z.string().min(1).max(100),
      termsText: z.string().min(10).max(50_000),
      notificationChannel: z.enum(['none','sms','voice']).default('none'),
      notificationRecipient: z.string().min(6).max(100).optional(),
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

  server.registerTool('review_grant_compliance', {
    title: 'Review grant compliance',
    description: 'Record an independent compliance decision and rationale before payment authorization.',
    inputSchema: {
      grantId: uuid,
      decision: z.enum(['approved','blocked','needs_review']),
      rationale: z.string().min(5).max(20_000),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Recorded grant compliance review.', { review: await service.reviewCompliance(actor, args) }));

  server.registerTool('authorize_manual_payment', {
    title: 'Authorize manual payment',
    description: 'Authorize a manual/external payment record only after recipient acceptance, fresh authoritative CRA status verification and compliance approval. This tool cannot execute a bank transfer.',
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
}
