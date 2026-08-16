import { buildPortfolioPlan, allocationPlanHash } from '../matching/portfolio.mjs';
import { PERMISSIONS, requireOrgPermission } from '../security/rbac.mjs';

function normalizeBn(value) {
  return String(value || '').toUpperCase().replace(/[\s-]/g, '');
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
  const foundationBn = normalizeBn(foundationOrg.business_number);
  if (!foundationBn) throw new Error('Foundation organization must have a T3010 business number before portfolio matching.');

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
      note: 'This is a planning portfolio based on public T3010 evidence and explicit constraints. It is not an award or a legal eligibility determination.'
    }
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

  const normalized = allocations.map(item => ({
    businessNumber: normalizeBn(item.businessNumber),
    amountCad: Number(item.amountCad)
  }));
  const seen = new Set();
  for (const item of normalized) {
    if (!item.businessNumber || !Number.isFinite(item.amountCad) || item.amountCad <= 0) throw new Error('Every allocation requires a valid businessNumber and positive amountCad.');
    if (seen.has(item.businessNumber)) throw new Error(`Duplicate recipient business number: ${item.businessNumber}`);
    seen.add(item.businessNumber);
  }

  const computedHash = allocationPlanHash({ foundationOrgId, purpose, allocations: normalized });
  if (computedHash !== planHash) throw new Error('Portfolio plan hash does not match the supplied foundation, purpose and allocations. Rebuild or reapprove the plan.');

  // Validate every recipient against the loaded charity registry before creating any grant draft.
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
      idempotencyKey: `${idempotencyKey}:${item.businessNumber}`.slice(0, 200)
    });
    drafts.push({ grant, recipient: { businessNumber: item.businessNumber, name: item.profile.name } });
  }

  return {
    planHash,
    foundationOrgId,
    purpose,
    draftCount: drafts.length,
    totalCad: Math.round(drafts.reduce((sum, entry) => sum + entry.grant.amountCad, 0) * 100) / 100,
    drafts,
    note: 'Only draft grants were created. No proposal, approval, offer, notification, payment, or award action was performed.'
  };
}
