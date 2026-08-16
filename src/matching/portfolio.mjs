import crypto from 'node:crypto';

const BN_PATTERN = /^\d{9}RR\d{4}$/i;

export function normalizeCharityBn(value) {
  const bn = String(value || '').toUpperCase().replace(/[\s-]/g, '');
  return BN_PATTERN.test(bn) ? bn : '';
}

export function moneyToCents(value, name = 'amountCad') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${name} must be a finite non-negative amount.`);
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-7) throw new Error(`${name} must not contain fractions of a cent.`);
  if (!Number.isSafeInteger(rounded)) throw new Error(`${name} is outside the safe monetary range.`);
  return rounded;
}

function positiveMoneyToCents(value, name) {
  const cents = moneyToCents(value, name);
  if (cents <= 0) throw new Error(`${name} must be positive.`);
  return cents;
}

function cad(cents) {
  return cents / 100;
}

function normalizeCandidate(candidate) {
  const businessNumber = normalizeCharityBn(candidate?.bn || candidate?.businessNumber);
  if (!businessNumber) return null;
  const score = Number(candidate?.score);
  return {
    businessNumber,
    name: String(candidate?.name || businessNumber),
    score: Number.isFinite(score) && score > 0 ? score : 0,
    province: candidate?.province || null,
    city: candidate?.city || null,
    matchedTerms: Array.isArray(candidate?.matchedTerms) ? candidate.matchedTerms : [],
    rationale: String(candidate?.rationale || '')
  };
}

function distributeWeightedSurplus(allocations, remainingCents, maxGrantCents) {
  let remaining = remainingCents;
  let guard = 0;

  while (remaining > 0 && guard < 1_000) {
    guard += 1;
    const active = allocations.filter(item => item.amountCents < maxGrantCents);
    if (!active.length) break;
    const totalWeight = active.reduce((sum, item) => sum + item.score, 0);
    if (!(totalWeight > 0)) break;

    const available = remaining;
    let distributed = 0;
    for (const item of active) {
      const capacity = maxGrantCents - item.amountCents;
      if (capacity <= 0) continue;
      const proportional = Math.floor(available * (item.score / totalWeight));
      const add = Math.min(capacity, proportional, remaining - distributed);
      if (add <= 0) continue;
      item.amountCents += add;
      distributed += add;
      if (distributed >= remaining) break;
    }

    remaining -= distributed;
    if (distributed === 0) {
      const target = [...active].sort((a, b) => b.score - a.score || a.businessNumber.localeCompare(b.businessNumber))[0];
      if (!target || target.amountCents >= maxGrantCents) break;
      target.amountCents += 1;
      remaining -= 1;
    }
  }

  if (guard >= 1_000 && remaining > 0) throw new Error('Allocator convergence invariant violated.');
  return remaining;
}

export function allocationPlanHash({ foundationOrgId, purpose, allocations }) {
  const canonical = {
    version: 1,
    foundationOrgId: String(foundationOrgId || ''),
    purpose: String(purpose || '').trim(),
    allocations: [...(allocations || [])]
      .map(item => ({
        businessNumber: normalizeCharityBn(item.businessNumber || item.bn),
        amountCents: moneyToCents(item.amountCad, 'allocation amountCad')
      }))
      .sort((a, b) => a.businessNumber.localeCompare(b.businessNumber))
  };
  if (canonical.allocations.some(item => !item.businessNumber)) throw new Error('Every allocation must contain a valid registered-charity BN.');
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
  const budgetCents = positiveMoneyToCents(budgetCad, 'budgetCad');
  const minGrantCents = positiveMoneyToCents(minGrantCad, 'minGrantCad');
  const maxGrantCents = positiveMoneyToCents(maxGrantCad, 'maxGrantCad');
  if (maxGrantCents < minGrantCents) throw new Error('maxGrantCad must be greater than or equal to minGrantCad.');
  if (!Number.isInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 500) throw new Error('maxRecipients must be an integer between 1 and 500.');
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) throw new Error('minimumScore must be between 0 and 1.');

  const seen = new Set();
  const eligible = candidates
    .map(normalizeCandidate)
    .filter(Boolean)
    .filter(candidate => candidate.score > 0 && candidate.score >= minimumScore)
    .filter(candidate => {
      if (seen.has(candidate.businessNumber)) return false;
      seen.add(candidate.businessNumber);
      return true;
    })
    .sort((a, b) => b.score - a.score || a.businessNumber.localeCompare(b.businessNumber));

  const maxAffordable = Math.floor(budgetCents / minGrantCents);
  const recipientCount = Math.min(maxRecipients, eligible.length, maxAffordable);
  const warnings = [];

  if (recipientCount === 0) {
    warnings.push('No allocation can be made within the minimum-grant, evidence-score and candidate constraints.');
    const allocations = [];
    return {
      foundationOrgId,
      purpose,
      budgetCad: cad(budgetCents),
      allocatedCad: 0,
      unallocatedCad: cad(budgetCents),
      allocations,
      candidateCount: eligible.length,
      recipientCount: 0,
      constraints: { minGrantCad: cad(minGrantCents), maxGrantCad: cad(maxGrantCents), maxRecipients, minimumScore },
      warnings,
      planHash: allocationPlanHash({ foundationOrgId, purpose, allocations })
    };
  }

  const selected = eligible.slice(0, recipientCount);
  const allocatableCents = Math.min(budgetCents, recipientCount * maxGrantCents);
  const allocationsInternal = selected.map(candidate => ({ ...candidate, amountCents: minGrantCents }));
  const baselineCents = recipientCount * minGrantCents;
  distributeWeightedSurplus(allocationsInternal, allocatableCents - baselineCents, maxGrantCents);

  const allocatedCents = allocationsInternal.reduce((sum, item) => sum + item.amountCents, 0);
  if (allocatedCents > budgetCents) throw new Error('Allocator invariant violated: allocated amount exceeds budget.');
  if (allocationsInternal.some(item => item.amountCents < minGrantCents || item.amountCents > maxGrantCents)) {
    throw new Error('Allocator invariant violated: grant amount outside supplied bounds.');
  }

  const unallocatedCents = budgetCents - allocatedCents;
  const requiredRecipientsToFullyAllocate = Math.ceil(budgetCents / maxGrantCents);
  if (unallocatedCents > 0) {
    if (eligible.length < requiredRecipientsToFullyAllocate) warnings.push('Candidate supply is insufficient to allocate the full budget at the maximum grant size.');
    if (maxRecipients < requiredRecipientsToFullyAllocate) warnings.push('maxRecipients prevents full budget allocation at the maximum grant size.');
    warnings.push(`CAD ${cad(unallocatedCents).toFixed(2)} remains unallocated under the supplied constraints.`);
  }

  const allocations = allocationsInternal.map(({ amountCents, ...item }) => ({ ...item, amountCad: cad(amountCents) }));
  return {
    foundationOrgId,
    purpose,
    budgetCad: cad(budgetCents),
    allocatedCad: cad(allocatedCents),
    unallocatedCad: cad(unallocatedCents),
    allocations,
    candidateCount: eligible.length,
    recipientCount: allocations.length,
    requiredRecipientsToFullyAllocate,
    constraints: { minGrantCad: cad(minGrantCents), maxGrantCad: cad(maxGrantCents), maxRecipients, minimumScore },
    warnings,
    planHash: allocationPlanHash({ foundationOrgId, purpose, allocations })
  };
}
