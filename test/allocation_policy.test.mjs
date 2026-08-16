import test from 'node:test';
import assert from 'node:assert/strict';
import { computePolicyCapacity } from '../src/automation/allocation_policies.mjs';
import { jobDefinitions } from '../src/automation/scheduler.mjs';

test('allocation policy capacity reserves active grants and reopens declined capacity externally', () => {
  const result = computePolicyCapacity({
    targetBudgetCad: 100000,
    activeAmountsCad: [40000, 35000],
    activeRecipientCount: 2,
    maxRecipients: 4,
    minGrantCad: 25000
  });
  assert.deepEqual(result, {
    targetCad: 100000,
    activeCad: 75000,
    remainingCad: 25000,
    slotsRemaining: 2,
    canCreateDrafts: true
  });
});

test('allocation policy does not create a draft below the minimum or over recipient cap', () => {
  assert.equal(computePolicyCapacity({ targetBudgetCad: 100000, activeAmountsCad: [80000], activeRecipientCount: 1, maxRecipients: 4, minGrantCad: 25000 }).canCreateDrafts, false);
  const capped = computePolicyCapacity({ targetBudgetCad: 100000, activeAmountsCad: [50000], activeRecipientCount: 2, maxRecipients: 2, minGrantCad: 25000 });
  assert.equal(capped.remainingCad, 50000);
  assert.equal(capped.slotsRemaining, 0);
  assert.equal(capped.canCreateDrafts, false);
});

test('scheduler enables allocation policies only behind both automation flags', () => {
  const base = { automationEnabled: true, automatedPortfoliosEnabled: true, allocationPolicyPollSeconds: 300, notificationProvider: 'disabled', notificationPollSeconds: 30, enableT3010Sync: false, t3010SyncIntervalHours: 24 };
  const enabled = jobDefinitions(base).find(job => job.name === 'allocation_policies');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.intervalSeconds, 300);
  assert.equal(jobDefinitions({ ...base, automatedPortfoliosEnabled: false }).find(job => job.name === 'allocation_policies').enabled, false);
});
