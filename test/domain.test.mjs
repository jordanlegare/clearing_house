import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTieredDQ, calculateFlatScenarioDQ, investmentScenario } from '../src/domain/dq.mjs';
import { capacitySaved } from '../src/domain/capacity.mjs';
import { nationalAllocationScenario } from '../src/matching/allocation.mjs';

test('flat 5% scenario on 135B is 6.75B', () => assert.equal(calculateFlatScenarioDQ(135e9, .05), 6.75e9));
test('tiered DQ uses 3.5% first 1M and 5% thereafter', () => assert.equal(calculateTieredDQ(2e6), 85_000));
test('8.5% return less 5% disbursement grows assets by 3.5% in one-year model', () => assert.equal(investmentScenario(135e9, .085, .05, 1).closingAssetsCad, 139.725e9));
test('104400 transactions recover modeled 5,533,200 hours', () => assert.equal(capacitySaved(104400).totalHours, 5_533_200));
test('national scenario reproduces the user assumptions', () => {
  const s = nationalAllocationScenario();
  assert.equal(s.grossReturnCad, 11.475e9);
  assert.equal(s.dqCad, 6.75e9);
  assert.equal(s.additionalDonees, 17_400);
  assert.equal(s.recipientUniverse, 104_400);
  assert.equal(s.administrativeCapacity.totalHours, 5_533_200);
});
