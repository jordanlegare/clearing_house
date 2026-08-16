import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSchedule8Line,
  deriveSchedule8Evidence,
  chooseDqBasis,
  reconcileEnvelope,
  dqSuggestionHash
} from '../src/domain/dq_evidence.mjs';

test('Schedule 8 line extraction tolerates schema-style prefixes without confusing nearby line numbers', () => {
  const fields = { dq_840: '85,000', line_8400_other: '999999', schedule8_line_870: '$2,000,000' };
  assert.deepEqual(extractSchedule8Line(fields, 840), { key: 'dq_840', valueCad: 85000 });
  assert.deepEqual(extractSchedule8Line(fields, 870), { key: 'schedule8_line_870', valueCad: 2000000 });
});

test('Schedule 8 evidence maps current and next-period DQ lines deterministically', () => {
  const evidence = deriveSchedule8Evidence({
    bn: '123456789RR0001', name: 'Example Foundation', sourceYear: 2025,
    disbursementQuotaFields: {
      dq_815: '2000000', dq_840: '85000', dq_860: '90000', dq_865: '5000',
      dq_870: '3000000', dq_890: '135000'
    }
  });
  assert.equal(evidence.current.line840DqRequirementCad, 85000);
  assert.equal(evidence.current.line865ExcessShortfallCad, 5000);
  assert.equal(evidence.next.line870PropertyCad, 3000000);
  assert.equal(evidence.next.estimatedDqCad, 135000);
  assert.equal(evidence.next.estimateLine, 890);
});

test('auto basis refuses stale Schedule 8 evidence outside current/next source vintage', () => {
  const evidence = deriveSchedule8Evidence({
    bn: '123456789RR0001', sourceYear: 2024,
    disbursementQuotaFields: { dq_840: '50000', dq_870: '2000000', dq_890: '85000' }
  });
  assert.equal(chooseDqBasis({ evidence, targetFiscalYear: 2024, mode: 'auto' }).grossDqCad, 50000);
  assert.equal(chooseDqBasis({ evidence, targetFiscalYear: 2025, mode: 'auto' }).grossDqCad, 85000);
  assert.throws(() => chooseDqBasis({ evidence, targetFiscalYear: 2026, mode: 'auto' }), /cannot be treated as a current DQ basis/);
});

test('explicit current property basis uses tiered DQ and flat mode remains a labeled scenario', () => {
  const evidence = { sourceYear: 2024 };
  const tiered = chooseDqBasis({ evidence, targetFiscalYear: 2026, mode: 'tiered_property', eligiblePropertyCad: 135_000_000_000 });
  assert.equal(tiered.budgetBasis, 'dq_explicit_property');
  assert.equal(tiered.grossDqCad, 6_749_985_000);
  const flat = chooseDqBasis({ evidence, targetFiscalYear: 2026, mode: 'flat_scenario', eligiblePropertyCad: 135_000_000_000, flatRate: 0.05 });
  assert.equal(flat.budgetBasis, 'dq_flat_scenario');
  assert.equal(flat.grossDqCad, 6_750_000_000);
});

test('envelope reconciliation separates executed, attributed pipeline, unattributed pipeline and policy reservations', () => {
  const reconciled = reconcileEnvelope({
    grossDqCad: 100000,
    executedGrantCad: 10000,
    activePipelineCad: 20000,
    unattributedPipelineCad: 5000,
    existingPolicyUnfilledCad: 15000,
    otherExpectedQualifyingDisbursementsCad: 10000,
    includeUnattributedPipeline: true
  });
  assert.equal(reconciled.totalReservedOrExecutedCad, 60000);
  assert.equal(reconciled.suggestedUnreservedEnvelopeCad, 40000);
  assert.equal(reconciled.overReservedCad, 0);
});

test('suggestion hash changes when a reserved amount changes', () => {
  const base = {
    foundationOrgId: '00000000-0000-4000-8000-000000000001', foundationBn: '123456789RR0001', targetFiscalYear: 2026,
    windowStart: '2026-01-01', windowEnd: '2026-12-31', budgetBasis: 'dq_schedule8_next', grossDqCad: 85000,
    eligiblePropertyCad: 2000000, sourceYear: 2025, executedGrantCad: 5000, activePipelineCad: 10000,
    unattributedPipelineCad: 0, existingPolicyUnfilledCad: 20000, otherExpectedQualifyingDisbursementsCad: 10000,
    includeUnattributedPipeline: true, suggestedUnreservedEnvelopeCad: 40000
  };
  const a = dqSuggestionHash(base);
  const b = dqSuggestionHash({ ...base, activePipelineCad: 11000, suggestedUnreservedEnvelopeCad: 39000 });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
});
