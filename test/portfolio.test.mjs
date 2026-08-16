import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationPlanHash, buildPortfolioPlan, moneyToCents } from '../src/matching/portfolio.mjs';

function candidates(count, { start = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    bn: `${String(start + index).padStart(9, '0')}RR0001`,
    name: `Charity ${index + 1}`,
    score: Math.max(0.01, 1 - index / Math.max(count, 2)),
    province: 'ON',
    matchedTerms: ['housing'],
    rationale: 'test evidence'
  }));
}

test('allocator never exceeds budget or grant bounds and uses cent accounting', () => {
  const plan = buildPortfolioPlan({
    foundationOrgId: 'foundation-1',
    budgetCad: 1_000_000,
    candidates: candidates(20),
    minGrantCad: 25_000,
    maxGrantCad: 125_000,
    maxRecipients: 20,
    purpose: 'Housing support'
  });
  const totalCents = plan.allocations.reduce((sum, item) => sum + moneyToCents(item.amountCad), 0);
  assert.equal(totalCents, moneyToCents(plan.allocatedCad));
  assert.ok(totalCents <= moneyToCents(plan.budgetCad));
  for (const item of plan.allocations) {
    const amount = moneyToCents(item.amountCad);
    assert.ok(amount >= moneyToCents(25_000));
    assert.ok(amount <= moneyToCents(125_000));
  }
});

test('allocator reports an unallocated remainder instead of inventing recipients', () => {
  const plan = buildPortfolioPlan({
    foundationOrgId: 'foundation-1',
    budgetCad: 1_000_000,
    candidates: candidates(2),
    minGrantCad: 25_000,
    maxGrantCad: 100_000,
    maxRecipients: 2
  });
  assert.equal(plan.allocatedCad, 200_000);
  assert.equal(plan.unallocatedCad, 800_000);
  assert.equal(plan.recipientCount, 2);
  assert.ok(plan.warnings.some(value => /unallocated/i.test(value)));
});

test('zero-evidence candidates are not allocated', () => {
  const plan = buildPortfolioPlan({
    foundationOrgId: 'foundation-1',
    budgetCad: 100_000,
    candidates: [
      { bn: '000000001RR0001', name: 'No Evidence', score: 0 },
      { bn: '000000002RR0001', name: 'Evidence', score: 0.5 }
    ],
    minGrantCad: 25_000,
    maxGrantCad: 100_000
  });
  assert.equal(plan.recipientCount, 1);
  assert.equal(plan.allocations[0].businessNumber, '000000002RR0001');
});

test('money values reject fractions of a cent', () => {
  assert.throws(() => moneyToCents(100.001), /fractions of a cent/i);
  assert.throws(() => buildPortfolioPlan({
    foundationOrgId: 'foundation-1',
    budgetCad: 1000.001,
    candidates: candidates(1),
    minGrantCad: 100,
    maxGrantCad: 1000
  }), /fractions of a cent/i);
});

test('plan hash is stable by recipient order and changes with cent amount', () => {
  const input = {
    foundationOrgId: 'foundation-1',
    purpose: 'Housing support',
    allocations: [
      { businessNumber: '000000001RR0001', amountCad: 50_000 },
      { businessNumber: '000000002RR0001', amountCad: 75_000 }
    ]
  };
  const first = allocationPlanHash(input);
  const reversed = allocationPlanHash({ ...input, allocations: [...input.allocations].reverse() });
  const changed = allocationPlanHash({ ...input, allocations: [{ ...input.allocations[0], amountCad: 50_000.01 }, input.allocations[1]] });
  assert.equal(first, reversed);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('minimumScore is constrained to the matcher score domain', () => {
  assert.throws(() => buildPortfolioPlan({
    foundationOrgId: 'foundation-1', budgetCad: 100_000, candidates: candidates(2), minimumScore: 1.1
  }), /between 0 and 1/i);
});
