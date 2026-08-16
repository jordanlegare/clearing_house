import crypto from 'node:crypto';
import { calculateTieredDQ, calculateFlatScenarioDQ } from './dq.mjs';
import { moneyToCents } from '../matching/portfolio.mjs';

function numberValue(value) {
  if (value === '' || value == null) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function extractSchedule8Line(fields = {}, lineNumber) {
  const target = String(lineNumber);
  const exact = [];
  const loose = [];
  for (const [key, value] of Object.entries(fields || {})) {
    const n = numberValue(value);
    if (n == null) continue;
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (normalized === target || normalized === `line_${target}` || normalized === `dq_${target}` || normalized.endsWith(`_line_${target}`) || normalized.endsWith(`_dq_${target}`)) exact.push([key, n]);
    else if (new RegExp(`(^|[^0-9])${target}([^0-9]|$)`).test(String(key))) loose.push([key, n]);
  }
  const match = exact[0] || loose[0] || null;
  return match ? { key: match[0], valueCad: match[1] } : null;
}

function lineMap(fields) {
  const lines = {};
  for (const line of [805,810,815,820,825,830,835,840,845,850,855,860,865,870,875,880,885,890]) {
    const found = extractSchedule8Line(fields, line);
    if (found) lines[line] = found;
  }
  return lines;
}

export function deriveSchedule8Evidence(profile) {
  if (!profile) throw new Error('Foundation profile is required.');
  const lines = lineMap(profile.disbursementQuotaFields || {});
  const currentPropertyBase = lines[815]?.valueCad ?? null;
  const currentRequirement = lines[840]?.valueCad ?? (currentPropertyBase != null ? calculateTieredDQ(currentPropertyBase) : null);
  const nextPropertyBase = lines[870]?.valueCad ?? null;
  let nextRequirement = null;
  let nextRequirementLine = null;
  if (nextPropertyBase != null) {
    nextRequirementLine = nextPropertyBase <= 1_000_000 ? 875 : 890;
    nextRequirement = lines[nextRequirementLine]?.valueCad ?? calculateTieredDQ(nextPropertyBase);
  } else if (lines[890]) {
    nextRequirementLine = 890;
    nextRequirement = lines[890].valueCad;
  } else if (lines[875]) {
    nextRequirementLine = 875;
    nextRequirement = lines[875].valueCad;
  }
  return {
    foundation: { bn: profile.bn, name: profile.name || profile.bn },
    sourceYear: Number(profile.sourceYear) || null,
    current: {
      line805PropertyCad: lines[805]?.valueCad ?? null,
      line810AccumulationAdjustmentCad: lines[810]?.valueCad ?? null,
      line815AdjustedPropertyCad: currentPropertyBase,
      line840DqRequirementCad: currentRequirement,
      line860QualifyingSpendingCad: lines[860]?.valueCad ?? null,
      line865ExcessShortfallCad: lines[865]?.valueCad ?? null
    },
    next: {
      line870PropertyCad: nextPropertyBase,
      estimatedDqCad: nextRequirement,
      estimateLine: nextRequirementLine
    },
    extractedLines: Object.fromEntries(Object.entries(lines).map(([line, item]) => [line, item.valueCad])),
    fieldKeys: Object.fromEntries(Object.entries(lines).map(([line, item]) => [line, item.key]))
  };
}

function centsToCad(value) { return value / 100; }

export function chooseDqBasis({ evidence, targetFiscalYear, mode = 'auto', eligiblePropertyCad = null, flatRate = 0.05 }) {
  const year = Number(targetFiscalYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('targetFiscalYear must be between 2000 and 2100.');
  const explicit = eligiblePropertyCad != null;
  if (mode === 'flat_scenario') {
    if (!explicit) throw new Error('eligiblePropertyCad is required for flat_scenario mode.');
    const baseCents = moneyToCents(eligiblePropertyCad, 'eligiblePropertyCad');
    const dq = calculateFlatScenarioDQ(centsToCad(baseCents), flatRate);
    return { budgetBasis: 'dq_flat_scenario', grossDqCad: dq, eligiblePropertyCad: centsToCad(baseCents), flatRate, source: 'explicit_scenario_assumption' };
  }
  if (mode === 'tiered_property' || explicit) {
    if (!explicit) throw new Error('eligiblePropertyCad is required for tiered_property mode.');
    const baseCents = moneyToCents(eligiblePropertyCad, 'eligiblePropertyCad');
    return { budgetBasis: 'dq_explicit_property', grossDqCad: calculateTieredDQ(centsToCad(baseCents)), eligiblePropertyCad: centsToCad(baseCents), source: 'explicit_eligible_property_assumption' };
  }
  if (mode !== 'auto') throw new Error('mode must be auto, tiered_property, or flat_scenario.');
  if (!evidence?.sourceYear) throw new Error('Schedule 8 source year is unavailable; provide eligiblePropertyCad explicitly.');
  if (year === evidence.sourceYear && evidence.current.line840DqRequirementCad != null) {
    return { budgetBasis: 'dq_schedule8_current', grossDqCad: evidence.current.line840DqRequirementCad, source: 'published_schedule8_line_840', sourceYear: evidence.sourceYear };
  }
  if (year === evidence.sourceYear + 1 && evidence.next.estimatedDqCad != null) {
    return { budgetBasis: 'dq_schedule8_next', grossDqCad: evidence.next.estimatedDqCad, eligiblePropertyCad: evidence.next.line870PropertyCad, source: evidence.next.estimateLine ? `published_or_recomputed_schedule8_line_${evidence.next.estimateLine}` : 'published_schedule8_next_estimate', sourceYear: evidence.sourceYear };
  }
  throw new Error(`Loaded Schedule 8 evidence is vintage ${evidence.sourceYear}; it cannot be treated as a current DQ basis for fiscal year ${year}. Provide an explicit current eligiblePropertyCad assumption.`);
}

export function reconcileEnvelope({
  grossDqCad,
  executedGrantCad = 0,
  activePipelineCad = 0,
  unattributedPipelineCad = 0,
  existingPolicyUnfilledCad = 0,
  otherExpectedQualifyingDisbursementsCad = 0,
  includeUnattributedPipeline = true
}) {
  const gross = moneyToCents(grossDqCad, 'grossDqCad');
  const executed = moneyToCents(executedGrantCad, 'executedGrantCad');
  const pipeline = moneyToCents(activePipelineCad, 'activePipelineCad');
  const unattributed = moneyToCents(unattributedPipelineCad, 'unattributedPipelineCad');
  const policy = moneyToCents(existingPolicyUnfilledCad, 'existingPolicyUnfilledCad');
  const other = moneyToCents(otherExpectedQualifyingDisbursementsCad, 'otherExpectedQualifyingDisbursementsCad');
  const reserved = executed + pipeline + policy + other + (includeUnattributedPipeline ? unattributed : 0);
  return {
    grossModeledDqCad: centsToCad(gross),
    executedGrantCad: centsToCad(executed),
    activePipelineCad: centsToCad(pipeline),
    unattributedPipelineCad: centsToCad(unattributed),
    existingPolicyUnfilledCad: centsToCad(policy),
    otherExpectedQualifyingDisbursementsCad: centsToCad(other),
    includeUnattributedPipeline,
    totalReservedOrExecutedCad: centsToCad(reserved),
    suggestedUnreservedEnvelopeCad: centsToCad(Math.max(0, gross - reserved)),
    overReservedCad: centsToCad(Math.max(0, reserved - gross))
  };
}

export function dqSuggestionHash(snapshot) {
  const canonical = {
    foundationOrgId: snapshot.foundationOrgId,
    foundationBn: snapshot.foundationBn,
    targetFiscalYear: snapshot.targetFiscalYear,
    windowStart: snapshot.windowStart,
    windowEnd: snapshot.windowEnd,
    budgetBasis: snapshot.budgetBasis,
    grossDqCad: Number(snapshot.grossDqCad),
    eligiblePropertyCad: snapshot.eligiblePropertyCad == null ? null : Number(snapshot.eligiblePropertyCad),
    sourceYear: snapshot.sourceYear ?? null,
    executedGrantCad: Number(snapshot.executedGrantCad),
    activePipelineCad: Number(snapshot.activePipelineCad),
    unattributedPipelineCad: Number(snapshot.unattributedPipelineCad),
    existingPolicyUnfilledCad: Number(snapshot.existingPolicyUnfilledCad),
    otherExpectedQualifyingDisbursementsCad: Number(snapshot.otherExpectedQualifyingDisbursementsCad),
    includeUnattributedPipeline: Boolean(snapshot.includeUnattributedPipeline),
    suggestedUnreservedEnvelopeCad: Number(snapshot.suggestedUnreservedEnvelopeCad)
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
