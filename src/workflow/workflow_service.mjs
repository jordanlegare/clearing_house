import { GRANT_STATES } from './grant_lifecycle.mjs';
import { PERMISSIONS, ROLES, requireGlobalRole, requireOrgPermission, scopedActor } from '../security/rbac.mjs';
import { classifyGrantReporting, RECIPIENT_TYPES } from '../compliance/reporting.mjs';
import { CRA_LIST_URL, normalizeCraObservedStatus } from '../compliance/status_verifier.mjs';

function requireActor(actor) {
  if (!actor?.id) throw new Error('Authentication is required for workflow tools.');
}

function orgIds(actor) {
  return [...new Set((actor.memberships || []).map(m => m.organizationId).filter(Boolean))];
}

export class WorkflowService {
  constructor({ repository, t3010Repository, config }) {
    this.repository = repository;
    this.t3010Repository = t3010Repository;
    this.config = config;
  }

  whoami(actor) {
    requireActor(actor);
    return actor;
  }

  async listGrants(actor, { limit = 50 } = {}) {
    requireActor(actor);
    return this.repository.listGrants({
      organizationIds: orgIds(actor),
      includeAll: (actor.roles || []).includes(ROLES.SYSTEM_ADMIN),
      limit
    });
  }

  async getGrant(actor, grantId) {
    requireActor(actor);
    const grant = await this.repository.getGrant(grantId);
    if (!grant) throw new Error('Grant not found.');
    if (!(actor.roles || []).includes(ROLES.SYSTEM_ADMIN) && !orgIds(actor).some(id => id === grant.foundationOrgId || id === grant.recipientOrgId)) {
      throw new Error('Actor cannot access this grant.');
    }
    return grant;
  }

  async claimRecipientOrganization(actor, { businessNumber, evidence = {}, idempotencyKey }) {
    requireActor(actor);
    const bn = String(businessNumber || '').toUpperCase().replace(/[\s-]/g, '');
    if (!this.t3010Repository?.loaded) throw new Error('T3010 repository must be loaded before claiming a registered charity.');
    const profile = this.t3010Repository.charityProfile(bn);
    if (!profile) throw new Error('Business number was not found in the loaded registered-charity T3010 dataset.');
    const organization = await this.repository.upsertPublicOrganization(profile, 'registered_charity');
    return this.repository.createOrganizationClaim({ actor, organizationId: organization.id, requestedRole: ROLES.RECIPIENT_ADMIN, evidence: { ...evidence, businessNumber: bn }, idempotencyKey });
  }

  async claimFoundationOrganization(actor, { businessNumber, evidence = {}, idempotencyKey }) {
    requireActor(actor);
    const bn = String(businessNumber || '').toUpperCase().replace(/[\s-]/g, '');
    if (!this.t3010Repository?.loaded) throw new Error('T3010 repository must be loaded before claiming a foundation.');
    const profile = this.t3010Repository.foundationProfile(bn);
    if (!profile) throw new Error('Business number was not found in the loaded foundation T3010 dataset.');
    const organization = await this.repository.upsertPublicOrganization(profile, 'foundation');
    return this.repository.createOrganizationClaim({ actor, organizationId: organization.id, requestedRole: ROLES.FOUNDATION_ANALYST, evidence: { ...evidence, businessNumber: bn }, idempotencyKey });
  }

  async grantOrganizationRole(actor, args) {
    requireGlobalRole(actor, ROLES.SYSTEM_ADMIN);
    return this.repository.grantMembershipBySubject({ actor, ...args });
  }

  async verifyRecipientClaim(actor, args) {
    requireGlobalRole(actor, ROLES.SYSTEM_ADMIN);
    return this.repository.verifyRecipientClaim({ actor, ...args });
  }

  async createGrant(actor, { foundationOrgId, recipientOrgId, amountCad, purpose, idempotencyKey }) {
    requireOrgPermission(actor, foundationOrgId, PERMISSIONS.PROPOSE_GRANT);
    const recipient = await this.repository.getOrganization(recipientOrgId);
    if (!recipient) throw new Error('Recipient organization not found.');
    const recipientType = ['registered_charity','foundation'].includes(recipient.organization_type)
      ? RECIPIENT_TYPES.QUALIFIED_DONEE
      : RECIPIENT_TYPES.NON_QUALIFIED_DONEE;
    return this.repository.createGrant({ actor, foundationOrgId, recipientOrgId, amountCad, purpose, recipientType, idempotencyKey });
  }

  async #transition(actor, grantId, nextState, input = {}) {
    const grant = await this.repository.getGrant(grantId);
    if (!grant) throw new Error('Grant not found.');
    const orgId = [GRANT_STATES.ACCEPTED, GRANT_STATES.DECLINED].includes(nextState) ? grant.recipientOrgId : grant.foundationOrgId;
    const permission = {
      [GRANT_STATES.PROPOSED]: PERMISSIONS.PROPOSE_GRANT,
      [GRANT_STATES.APPROVED]: PERMISSIONS.APPROVE_GRANT,
      [GRANT_STATES.OFFERED]: PERMISSIONS.OFFER_GRANT,
      [GRANT_STATES.ACCEPTED]: PERMISSIONS.ACCEPT_GRANT,
      [GRANT_STATES.DECLINED]: PERMISSIONS.DECLINE_GRANT,
      [GRANT_STATES.PAYMENT_AUTHORIZED]: PERMISSIONS.AUTHORIZE_PAYMENT,
      [GRANT_STATES.PAID]: PERMISSIONS.RECORD_PAYMENT,
      [GRANT_STATES.REPORTED]: PERMISSIONS.MARK_REPORTED
    }[nextState];
    requireOrgPermission(actor, orgId, permission);
    if (nextState === GRANT_STATES.PAYMENT_AUTHORIZED && this.config.paymentProvider !== 'manual') {
      throw new Error('PAYMENT_PROVIDER must be manual before payment authorization can be recorded.');
    }
    return this.repository.transitionGrantState({
      grantId,
      nextState,
      actor: scopedActor(actor, orgId),
      input,
      options: {
        requireSeparationOfDuties: this.config.requireSeparationOfDuties,
        maxStatusAgeHours: this.config.craStatusMaxAgeHours
      }
    });
  }

  proposeGrant(actor, args) { return this.#transition(actor, args.grantId, GRANT_STATES.PROPOSED, args); }
  approveGrant(actor, args) { return this.#transition(actor, args.grantId, GRANT_STATES.APPROVED, args); }
  async offerGrant(actor, args) {
    const grant = await this.#transition(actor, args.grantId, GRANT_STATES.OFFERED, args);
    let notification = null;
    if (args.notificationChannel && args.notificationChannel !== 'none') {
      if (!args.notificationRecipient) throw new Error('notificationRecipient is required when a notification channel is selected.');
      notification = await this.repository.queueNotification({
        actor, grantId: args.grantId, channel: args.notificationChannel, recipient: args.notificationRecipient,
        template: 'grant_offer', payload: { grantId: args.grantId, message: 'A funding offer is available for your organization. Sign in to review the terms.' },
        idempotencyKey: `${args.idempotencyKey}:notification`
      });
    }
    return { grant, notification };
  }
  acceptGrant(actor, args) { return this.#transition(actor, args.grantId, GRANT_STATES.ACCEPTED, { ...args, acceptedTerms: true }); }
  declineGrant(actor, args) { return this.#transition(actor, args.grantId, GRANT_STATES.DECLINED, args); }

  async recordCraStatusVerification(actor, { grantId, observedStatus, verifiedAt, evidence = {}, idempotencyKey }) {
    const grant = await this.repository.getGrant(grantId);
    if (!grant) throw new Error('Grant not found.');
    requireOrgPermission(actor, grant.foundationOrgId, PERMISSIONS.VERIFY_RECIPIENT_STATUS);
    const recipientOrg = await this.repository.getOrganization(grant.recipientOrgId);
    if (!recipientOrg) throw new Error('Recipient organization not found.');
    const normalized = normalizeCraObservedStatus(observedStatus);
    const checkedAt = new Date(verifiedAt || Date.now());
    if (Number.isNaN(checkedAt.getTime())) throw new Error('verifiedAt must be a valid timestamp.');
    const expiresAt = new Date(checkedAt.getTime() + this.config.craStatusMaxAgeHours * 60 * 60 * 1000);
    return this.repository.recordRecipientStatus({
      actor, grantId, source: 'cra_list_of_charities', sourceRecordId: recipientOrg.business_number || grant.recipientOrgId,
      status: normalized.status, assuranceLevel: normalized.assuranceLevel, observedStatus,
      evidence: { ...evidence, verificationUrl: CRA_LIST_URL }, verifiedAt: checkedAt.toISOString(),
      expiresAt: expiresAt.toISOString(), idempotencyKey
    });
  }

  async reviewCompliance(actor, { grantId, decision, rationale, idempotencyKey }) {
    const grant = await this.repository.getGrant(grantId);
    if (!grant) throw new Error('Grant not found.');
    requireOrgPermission(actor, grant.foundationOrgId, PERMISSIONS.REVIEW_COMPLIANCE);
    return this.repository.recordComplianceReview({ actor, grantId, decision, rationale, idempotencyKey });
  }

  authorizeManualPayment(actor, args) { return this.#transition(actor, args.grantId, GRANT_STATES.PAYMENT_AUTHORIZED, args); }
  recordManualPayment(actor, args) { return this.#transition(actor, args.grantId, GRANT_STATES.PAID, args); }

  async prepareReportingRecord(actor, { grantId, fiscalYear, fiscalPeriodStart, fiscalPeriodEnd, t3010Version = null, idempotencyKey }) {
    const grant = await this.repository.getGrant(grantId);
    if (!grant) throw new Error('Grant not found.');
    requireOrgPermission(actor, grant.foundationOrgId, PERMISSIONS.EXPORT_REPORTING);
    const paid = await this.repository.fiscalPeriodPaidGrants({ foundationOrgId: grant.foundationOrgId, periodStart: fiscalPeriodStart, periodEnd: fiscalPeriodEnd });
    const classification = classifyGrantReporting({
      recipientType: grant.recipientType,
      recipientOrgId: grant.recipientOrgId,
      fiscalYearGrants: paid
    });
    const payload = {
      grantId,
      foundationOrgId: grant.foundationOrgId,
      recipientOrgId: grant.recipientOrgId,
      amountCad: grant.amountCad,
      purpose: grant.purpose,
      fiscalYear,
      fiscalPeriodStart,
      fiscalPeriodEnd,
      classification,
      filingStatus: 'review_required_before_cra_submission'
    };
    return this.repository.upsertReportingRecord({
      actor, grantId, fiscalYear, route: classification.route, t1441Required: classification.t1441Required,
      payload, t3010Version, idempotencyKey
    });
  }

  async markGrantReported(actor, { grantId, reportingRecordId, submissionReference, idempotencyKey }) {
    const grant = await this.repository.getGrant(grantId);
    if (!grant) throw new Error('Grant not found.');
    requireOrgPermission(actor, grant.foundationOrgId, PERMISSIONS.MARK_REPORTED);
    const record = await this.repository.getReportingRecord(reportingRecordId);
    if (!record || record.grant_id !== grantId) throw new Error('Reporting record does not match grant.');
    if (!String(submissionReference || '').trim()) throw new Error('External CRA filing/submission reference is required before marking a grant reported.');
    await this.repository.markReportingRecordFiled({ actor, reportingRecordId, submissionReference, idempotencyKey: `${idempotencyKey}:filing` });
    return this.#transition(actor, grantId, GRANT_STATES.REPORTED, { reportingRecordId, submissionReference, idempotencyKey });
  }
}
