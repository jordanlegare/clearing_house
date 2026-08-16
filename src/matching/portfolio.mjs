import crypto from 'node:crypto';

function cents(value) {
  return Math.round(Number(value) * 100) / 100;
}

function finitePositive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive.`);
  return n;
}

function normalizeCandidate(candidate) {
  const bn = String(candidate.bn || candidate.businessNumber || '').toUpperCase().replace(/[\s-]/g, '');
  if (!bn) return null;
  const score = Number(candidate.score);
  return {
    businessNumber: bn,
    name: candidate.name || bn,
    score: Number.isFinite(score) && score > 0 ? score : 0.0001,
    province: candidate.province || null,
    city: candidate.city || null,
    matchedTerms: Array.isArray(candidate.matchedTerms) ? candidate.matchedTerms : [],
    rationale: candidate.rationale || ''
  };
}

function addWeightedSurplus(allocations, remainingCad, maxGrantCad) {
  let remaining = cents(remainingCad);
  for (let round = 0; round < 20 && remaining >= 0.01; round += 1) {
    const active = allocations.filter(item => item.amountCad < maxGrantCad - 0.005);
    if (!active.length) break;
    const weightTotal = active.reduce((sum, item) => sum + Math.max(item.score, 0.0001), 0);
    const before = remaining;
    const additions = active.map(item => {
      const capacity = cents(maxGrantCad - item.amountCad);
      const share = cents(before * (Math.max(item.score, 0.0001) / weightTotal));
      return { item, add: Math.min(capacity, share) };
    });
    const distributed = cents(additions.reduce((sum, entry) => sum + entry.add, 0));
    if (distributed < 0.01) break;
    for (const { item, add } of additions) item.amountCad = cents(item.amountCad + add);
    remaining = cents(remaining - distributed);
  }

  // Resolve cent-level rounding in deterministic score order without exceeding caps.
  const ordered = [...allocations].sort((a, b) => b.score - a.score || a.businessNumber.localeCompare(b.businessNumber));
  while (remaining >= 0.01) {
    const target = ordered.find(item => item.amountCad <= maxGrantCad - 0.01);
    if (!target) break;
    target.amountCad = cents(target.amountCad + 0.01);
    remaining = cents(remaining - 0.01);
  }
  return remaining;
}

export function allocationPlanHash({ foundationOrgId, purpose, allocations }) {
  const canonical = {
    foundationOrgId,
    purpose: String(purpose || '').trim(),
    allocations: [...allocations]
      .map(item => ({ businessNumber: String(item.businessNumber).toUpperCase().replace(/[\s-]/g, ''), amountCad: cents(item.amountCad) }))
      .sort((a, b) => a.businessNumber.localeCompare(b.businessNumber))
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildPortfolioPlan({
  foundationOrgId,
  budgetCad,
  candidates = [],
  minGrantCad = 25_000,
  maxGrantCad = 250_000,
  maxRecipients = 100,
  minimumScore = 0,
  purpose = 'General operating support'
}) {
  const budget = finitePositive(budgetCad, 'budgetCad');
  const minGrant = finitePositive(minGrantCad, 'minGrantCad');
  const maxGrant = finitePositive(maxGrantCad, 'maxGrantCad');
  if (maxGrant < minGrant) throw new Error('maxGrantCad must be greater than or equal to minGrantCad.');
  if (!Number.isInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 500) throw new Error('maxRecipients must be an integer between 1 and 500.');

  const seen = new Set();
  const eligible = candidates
    .map(normalizeCandidate)
    .filter(Boolean)
    .filter(candidate => candidate.score >= minimumScore)
    .filter(candidate => {
      if (seen.has(candidate.businessNumber)) return false;
      seen.add(candidate.businessNumber);
      return true;
    })
    .sort((a, b) => b.score - a.score || a.businessNumber.localeCompare(b.businessNumber));

  const maxAffordable = Math.floor(budget / minGrant);
  const recipientCount = Math.min(maxRecipients, eligible.length, maxAffordable);
  const warnings = [];

  if (recipientCount === 0) {
    warnings.push('No allocation can be made within the minimum-grant and candidate constraints.');
    return {
      foundationOrgId,
      purpose,
      budgetCad: cents(budget),
      allocatedCad: 0,
      unallocatedCad: cents(budget),
      allocations: [],
      candidateCount: eligible.length,
      recipientCount: 0,
      constraints: { minGrantCad: minGrant, maxGrantCad: maxGrant, maxRecipients, minimumScore },
      warnings,
      planHash: allocationPlanHash({ foundationOrgId, purpose, allocations: [] })
    };
  }

  const selected = eligible.slice(0, recipientCount);
  const allocatableCad = cents(Math.min(budget, recipientCount * maxGrant));
  const allocations = selected.map(candidate => ({ ...candidate, amountCad: cents(minGrant) }));
  let remaining = cents(allocatableCad - allocations.reduce((sum, item) => sum + item.amountCad, 0));
  remaining = addWeightedSurplus(allocations, remaining, maxGrant);

  const allocatedCad = cents(allocations.reduce((sum, item) => sum + item.amountCad, 0));
  const unallocatedCad = cents(budget - allocatedCad);
  const requiredRecipientsToFullyAllocate = Math.ceil(budget / maxGrant);
  if (unallocatedCad > 0) {
    if (eligible.length < requiredRecipientsToFullyAllocate) warnings.push('Candidate supply is insufficient to allocate the full budget at the maximum grant size.');
    if (maxRecipients < requiredRecipientsToFullyAllocate) warnings.push('maxRecipients prevents full budget allocation at the maximum grant size.');
    warnings.push(`CAD ${unallocatedCad.toFixed(2)} remains unallocated under the supplied constraints.`);
  }

  const planHash = allocationPlanHash({ foundationOrgId, purpose, allocations });
  return {
    foundationOrgId,
    purpose,
    budgetCad: cents(budget),
    allocatedCad,
    unallocatedCad,
    allocations,
    candidateCount: eligible.length,
    recipientCount: allocations.length,
    requiredRecipientsToFullyAllocate,
    constraints: { minGrantCad: minGrant, maxGrantCad: maxGrant, maxRecipients, minimumScore },
    warnings,
    planHash
  };
}
