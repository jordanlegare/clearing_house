import crypto from 'node:crypto';
import { allocationPlanHash, buildPortfolioPlan, moneyToCents, normalizeCharityBn } from '../matching/portfolio.mjs';
import { PERMISSIONS, requireOrgPermission } from '../security/rbac.mjs';

function cad(cents) {
  return cents / 100;
}

function draftIdempotencyKey(portfolioKey, businessNumber) {
  return crypto.createHash('sha256').update(`${portfolioKey}|${businessNumber}`).digest('hex');
}

export async function buildFoundationPortfolio(service, actor, {
  foundationOrgId,
  budgetCad,
  focus = '',
  province = '',
  minGrantCad = 25_000,
  maxGrantCad = 250_000,
  maxRecipients = 100,
  minimumScore = 0,
  purpose = 'General operating support'
}) {
  requireOrgPermission(actor, foundationOrgId, PERMISSIONS.PROPOSE_GRANT);
  if (!service.t3010Repository?.loaded) throw new Error('T3010 repository must be loaded to build a recipient portfolio.');

  const foundationOrg = await service.repository.getOrganization(foundationOrgId);
  if (!foundationOrg || foundationOrg.organization_type !== 'foundation') throw new Error('Foundation organization not found.');
  const foundationBn = normalizeCharityBn(foundationOrg.business_number);
  if (!foundationBn) throw new Error('Foundation organization must have a valid registered-charity BN before portfolio matching.');

  const matchLimit = Math.min(500, Math.max(maxRecipients * 5, 100));
  const match = service.t3010Repository.matchFoundation({ foundationBn, focus, province, limit: matchLimit });
  const plan = buildPortfolioPlan({
    foundationOrgId,
    budgetCad,
    candidates: match.matches,
    minGrantCad,
    maxGrantCad,
    maxRecipients,
    minimumScore,
    purpose
  });

  return {
    ...plan,
    foundation: { organizationId: foundationOrgId, businessNumber: foundationBn, name: foundationOrg.legal_name },
    matching: {
      confidence: match.confidence,
      evidenceTokens: match.evidenceTokens,
      candidateCountBeforeConstraints: match.matches.length,
      note: 'Planning support only. Public T3010 evidence and explicit constraints do not constitute an award, current legal-status verification, or CRA approval.'
    },
    hashMeaning: 'Integrity binding only: planHash binds the foundation, purpose and cent-denominated allocations. It is not proof that a foundation approved the plan.'
  };
}

export async function materializePortfolioDrafts(service, actor, {
  foundationOrgId,
  purpose,
  allocations,
  planHash,
  idempotencyKey
}) {
  requireOrgPermission(actor, foundationOrgId, PERMISSIONS.PROPOSE_GRANT);
  if (!service.t3010Repository?.loaded) throw new Error('T3010 repository must be loaded before portfolio drafts can be created.');
  if (!Array.isArray(allocations) || !allocations.length) throw new Error('At least one allocation is required.');
  if (allocations.length > 500) throw new Error('A single portfolio draft action is limited to 500 recipients.');

  const normalized = allocations.map(item => {
    const businessNumber = normalizeCharityBn(item.businessNumber);
    const amountCents = moneyToCents(item.amountCad, 'allocation amountCad');
    if (!businessNumber || amountCents <= 0) throw new Error('Every allocation requires a valid registered-charity BN and positive cent-denominated amountCad.');
    return { businessNumber, amountCad: cad(amountCents) };
  });

  const seen = new Set();
  for (const item of normalized) {
    if (seen.has(item.businessNumber)) throw new Error(`Duplicate recipient business number: ${item.businessNumber}`);
    seen.add(item.businessNumber);
  }

  const computedHash = allocationPlanHash({ foundationOrgId, purpose, allocations: normalized });
  if (computedHash !== planHash) throw new Error('Portfolio plan hash does not match the supplied foundation, purpose and allocations. Rebuild or review the plan before materializing drafts.');

  // Validate every recipient against the loaded public registered-charity dataset before creating any draft.
  // Current authoritative status is still required later by the payment-release gate.
  const validated = normalized.map(item => {
    const profile = service.t3010Repository.charityProfile(item.businessNumber);
    if (!profile) throw new Error(`Recipient ${item.businessNumber} is not present in the loaded registered-charity T3010 dataset.`);
    return { ...item, profile };
  });

  const drafts = [];
  for (const item of validated) {
    const recipientOrg = await service.repository.upsertPublicOrganization(item.profile, 'registered_charity');
    const grant = await service.createGrant(actor, {
      foundationOrgId,
      recipientOrgId: recipientOrg.id,
      amountCad: item.amountCad,
      purpose,
      idempotencyKey: draftIdempotencyKey(idempotencyKey, item.businessNumber)
    });
    drafts.push({ grant, recipient: { businessNumber: item.businessNumber, name: item.profile.name } });
  }

  const totalCents = drafts.reduce((sum, entry) => sum + moneyToCents(entry.grant.amountCad, 'grant amountCad'), 0);
  return {
    planHash,
    foundationOrgId,
    purpose,
    draftCount: drafts.length,
    totalCad: cad(totalCents),
    drafts,
    note: 'Only draft grants were created. No proposal, approval, offer, notification, compliance decision, payment authorization, bank transfer, or award action was performed.'
  };
}
