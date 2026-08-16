import { PERMISSIONS, requirePermission } from '../security/rbac.mjs';
import { isReleaseEligibleStatusCheck } from '../compliance/status_verifier.mjs';

export const GRANT_STATES = Object.freeze({
  DRAFT: 'draft',
  PROPOSED: 'proposed',
  APPROVED: 'approved',
  OFFERED: 'offered',
  ACCEPTED: 'accepted',
  PAYMENT_AUTHORIZED: 'payment_authorized',
  PAID: 'paid',
  REPORTED: 'reported',
  DECLINED: 'declined',
  CANCELLED: 'cancelled'
});

const terminal = new Set([GRANT_STATES.REPORTED, GRANT_STATES.DECLINED, GRANT_STATES.CANCELLED]);
const allowed = new Map([
  [GRANT_STATES.DRAFT, new Set([GRANT_STATES.PROPOSED, GRANT_STATES.CANCELLED])],
  [GRANT_STATES.PROPOSED, new Set([GRANT_STATES.APPROVED, GRANT_STATES.CANCELLED])],
  [GRANT_STATES.APPROVED, new Set([GRANT_STATES.OFFERED, GRANT_STATES.CANCELLED])],
  [GRANT_STATES.OFFERED, new Set([GRANT_STATES.ACCEPTED, GRANT_STATES.DECLINED, GRANT_STATES.CANCELLED])],
  [GRANT_STATES.ACCEPTED, new Set([GRANT_STATES.PAYMENT_AUTHORIZED, GRANT_STATES.CANCELLED])],
  [GRANT_STATES.PAYMENT_AUTHORIZED, new Set([GRANT_STATES.PAID])],
  [GRANT_STATES.PAID, new Set([GRANT_STATES.REPORTED])]
]);

const permissionFor = new Map([
  [GRANT_STATES.PROPOSED, PERMISSIONS.PROPOSE_GRANT],
  [GRANT_STATES.APPROVED, PERMISSIONS.APPROVE_GRANT],
  [GRANT_STATES.OFFERED, PERMISSIONS.OFFER_GRANT],
  [GRANT_STATES.ACCEPTED, PERMISSIONS.ACCEPT_GRANT],
  [GRANT_STATES.DECLINED, PERMISSIONS.DECLINE_GRANT],
  [GRANT_STATES.PAYMENT_AUTHORIZED, PERMISSIONS.AUTHORIZE_PAYMENT],
  [GRANT_STATES.PAID, PERMISSIONS.RECORD_PAYMENT],
  [GRANT_STATES.REPORTED, PERMISSIONS.MARK_REPORTED]
]);

function assertProposal(grant) {
  if (!grant.foundationOrgId || !grant.recipientOrgId) throw new Error('Foundation and recipient are required.');
  if (!Number.isFinite(grant.amountCad) || grant.amountCad <= 0) throw new Error('Positive CAD grant amount is required.');
  if (!String(grant.purpose || '').trim()) throw new Error('Grant purpose is required.');
}

export function transitionGrant(grant, nextState, actor, input = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxStatusAgeHours = options.maxStatusAgeHours ?? 24;
  if (!grant?.state) throw new Error('Grant state is required.');
  if (terminal.has(grant.state)) throw new Error(`Grant is terminal in state ${grant.state}.`);
  if (!allowed.get(grant.state)?.has(nextState)) throw new Error(`Invalid grant transition ${grant.state} -> ${nextState}.`);

  const permission = permissionFor.get(nextState);
  if (permission) requirePermission(actor, permission);

  if (nextState === GRANT_STATES.PROPOSED) assertProposal(grant);
  if (nextState === GRANT_STATES.APPROVED && options.requireSeparationOfDuties !== false && grant.proposedBy === actor.id) {
    throw new Error('Separation of duties: proposer cannot approve the same grant.');
  }
  if (nextState === GRANT_STATES.OFFERED) {
    if (!String(input.termsVersion || '').trim()) throw new Error('termsVersion is required when offering a grant.');
    if (!String(input.termsText || '').trim()) throw new Error('termsText is required when offering a grant.');
  }
  if (nextState === GRANT_STATES.ACCEPTED) {
    if (actor.organizationId !== grant.recipientOrgId) throw new Error('Recipient acceptance must come from the recipient organization.');
    if (input.acceptedTerms !== true) throw new Error('Recipient must explicitly accept grant terms.');
    if (!grant.termsVersion || input.termsVersion !== grant.termsVersion) throw new Error('Recipient must accept the currently offered terms version.');
  }
  if (nextState === GRANT_STATES.PAYMENT_AUTHORIZED) {
    if (!isReleaseEligibleStatusCheck(grant.recipientStatus, { now, maxAgeHours: maxStatusAgeHours })) {
      throw new Error('Fresh authoritative eligible-recipient status verification is required before payment authorization.');
    }
    if (grant.compliance?.decision !== 'approved') throw new Error('Compliance approval is required before payment authorization.');
  }
  if (nextState === GRANT_STATES.PAID && !String(input.externalPaymentReference || '').trim()) {
    throw new Error('External payment reference is required to record a paid grant.');
  }
  if (nextState === GRANT_STATES.REPORTED && !input.reportingRecordId) throw new Error('Reporting record is required before marking a grant reported.');

  const event = {
    idempotencyKey: input.idempotencyKey || null,
    fromState: grant.state,
    toState: nextState,
    actorId: actor.id,
    occurredAt: now.toISOString(),
    metadata: { ...input }
  };
  return { ...grant, state: nextState, updatedAt: event.occurredAt, lastEvent: event };
}
