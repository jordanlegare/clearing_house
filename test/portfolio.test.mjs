import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioPlan, allocationPlanHash } from '../src/matching/portfolio.mjs';

function candidates(n) {
  return Array.from({ length: n }, (_, index) => ({
    bn: `${String(100000000 + index)}RR0001`,
    name: `Charity ${index + 1}`,
    score: 1 / (index + 1),
    matchedTerms: ['housing'],
    rationale: 'Shared T3010 evidence terms: housing'
  }));
}

test('portfolio allocator stays within budget and grant constraints', () => {
  const plan = buildPortfolioPlan({
    foundationOrgId: 'foundation-1',
    budgetCad: 1_000_000,
    candidates: candidates(20),
    minGrantCad: 25_000,
    maxGrantCad: 100_000,
    maxRecipients: 20,
    purpose: 'Housing support'
  });
  assert.equal(plan.allocatedCad, 1_000_000);
  assert.equal(plan.unallocatedCad, 0);
  assert.ok(plan.allocations.length <= 20);
  assert.ok(plan.allocations.every(item => item.amountCad >= 25_000 && item.amountCad <= 100_000));
  assert.equal(plan.allocations.reduce((sum, item) => sum + item.amountCad, 0), plan.allocatedCad);
});

test('portfolio allocator reports unallocated funds rather than exceeding caps', () => {
  const plan = buildPortfolioPlan({
    foundationOrgId: 'foundation-1',
    budgetCad: 1_000_000,
    candidates: candidates(3),
    minGrantCad: 25_000,
    maxGrantCad: 100_000,
    maxRecipients: 3,
    purpose: 'Food security'
  });
  assert.equal(plan.allocatedCad, 300_000);
  assert.equal(plan.unallocatedCad, 700_000);
  assert.match(plan.warnings.join(' '), /remains unallocated/);
});

test('portfolio allocator does not create sub-minimum grants', () => {
  const plan = buildPortfolioPlan({
    foundationOrgId: 'foundation-1',
    budgetCad: 10_000,
    candidates: candidates(5),
    minGrantCad: 25_000,
    maxGrantCad: 100_000
  });
  assert.equal(plan.recipientCount, 0);
  assert.equal(plan.allocatedCad, 0);
  assert.equal(plan.unallocatedCad, 10_000);
});

test('plan hash is deterministic and changes when allocations change', () => {
  const input = {
    foundationOrgId: 'foundation-1',
    purpose: 'Operating support',
    allocations: [
      { businessNumber: '111111111RR0001', amountCad: 50000 },
      { businessNumber: '222222222RR0001', amountCad: 75000 }
    ]
  };
  const a = allocationPlanHash(input);
  const b = allocationPlanHash({ ...input, allocations: [...input.allocations].reverse() });
  const c = allocationPlanHash({ ...input, allocations: [{ ...input.allocations[0], amountCad: 50001 }, input.allocations[1]] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});
