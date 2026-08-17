import crypto from 'node:crypto';

export const READINESS_CODES = Object.freeze([
  'profile.mission_missing',
  'profile.activities_missing',
  'profile.populations_missing',
  'profile.geography_missing',
  'profile.outcomes_missing',
  'profile.evidence_missing',
  'request.objectives_missing',
  'request.activities_missing',
  'request.outcomes_missing',
  'request.budget_missing',
  'request.evidence_missing',
  'request.budget_total_mismatch',
  'foundation.evidence_missing',
  'foundation.match_terms_missing',
  'foundation.match_evidence_incomplete'
]);

const findingMessages = Object.freeze({
  'profile.mission_missing': 'Add the recipient organization mission.',
  'profile.activities_missing': 'Add at least one current organization activity.',
  'profile.populations_missing': 'Add at least one population served.',
  'profile.geography_missing': 'Add at least one service geography.',
  'profile.outcomes_missing': 'Add at least one organization-level outcome.',
  'profile.evidence_missing': 'Add at least one recipient evidence reference.',
  'request.objectives_missing': 'Add at least one funding-request objective.',
  'request.activities_missing': 'Add at least one funded activity.',
  'request.outcomes_missing': 'Add at least one expected request outcome.',
  'request.budget_missing': 'Add at least one request budget line.',
  'request.evidence_missing': 'Add at least one request evidence reference.',
  'request.budget_total_mismatch': 'Make the request budget total equal the requested amount.',
  'foundation.evidence_missing': 'Verify foundation program or historical support evidence.',
  'foundation.match_terms_missing': 'Confirm at least one shared recipient/foundation evidence term.',
  'foundation.match_evidence_incomplete': 'Retain source evidence for every shared recipient/foundation term.'
});

const terminalStatuses = new Set(['awarded', 'declined', 'withdrawn']);
const allowedTransitions = new Map([
  ['draft', new Set(['ready', 'withdrawn'])],
  ['ready', new Set(['submitted', 'withdrawn'])],
  ['submitted', new Set(['awarded', 'declined', 'withdrawn'])]
]);

function cleanString(value, { max = 10_000 } = {}) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > max) throw new Error(`Text exceeds ${max} characters.`);
  return normalized;
}

function cleanArray(value, { maxItems = 100 } = {}) {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) throw new Error(`Array exceeds ${maxItems} items.`);
  return value.map(item => {
    if (typeof item === 'string') return cleanString(item);
    if (item && typeof item === 'object') return canonicalValue(item);
    return item;
  }).filter(item => typeof item !== 'string' || item.length > 0);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function flattenApprovedText(value) {
  const leaves = [];
  const visit = candidate => {
    if (typeof candidate === 'string') {
      const normalized = cleanString(candidate);
      if (normalized) leaves.push(normalized);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate && typeof candidate === 'object') {
      for (const item of Object.values(candidate)) visit(item);
    }
  };
  visit(value);
  return leaves.join(' ');
}

export function jsonStringLeavesWithin(value, maxLength = 10_000) {
  const stack = [value];
  const seen = new Set();
  while (stack.length) {
    const candidate = stack.pop();
    if (typeof candidate === 'string' && candidate.length > maxLength) return false;
    if (!candidate || typeof candidate !== 'object') continue;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  return true;
}

function evidenceTokenSet(value) {
  return new Set(String(value ?? '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) ?? []);
}

function isoTimestamp(value, fieldName) {
  const stringValue = cleanString(value, { max: 100 });
  const parsed = new Date(stringValue);
  if (!stringValue || Number.isNaN(parsed.getTime())) throw new Error(`${fieldName} must be a valid ISO timestamp.`);
  return parsed.toISOString();
}

function evidenceTimestamp(value, fieldName, { earliest, earliestLabel, now }) {
  const normalized = isoTimestamp(value, fieldName);
  const time = new Date(normalized).getTime();
  if (earliest && time < new Date(earliest).getTime()) {
    throw new Error(`${fieldName} cannot be before the application ${earliestLabel}.`);
  }
  if (time > now.getTime() + 5 * 60_000) {
    throw new Error(`${fieldName} cannot be more than five minutes in the future.`);
  }
  return normalized;
}

export function moneyToCents(value, fieldName = 'amountCad') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${fieldName} must be a finite non-negative amount.`);
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-7) throw new Error(`${fieldName} must not contain fractions of a cent.`);
  if (!Number.isSafeInteger(rounded)) throw new Error(`${fieldName} is outside the safe monetary range.`);
  return rounded;
}

function normalizeBudget(lines) {
  return cleanArray(lines).map((line, index) => {
    const amountCents = moneyToCents(line?.amountCad, `budget[${index}].amountCad`);
    return {
      label: cleanString(line?.label, { max: 500 }),
      amountCad: amountCents / 100,
      amountCents
    };
  });
}

function normalizeMatchEvidence(value) {
  return cleanArray(value).map((item, index) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') {
      throw new Error(`matchEvidence[${index}] must be an object.`);
    }
    const excerpt = cleanString(item.excerpt, { max: 2_000 });
    const matchedTerms = [...new Set(cleanArray(item.matchedTerms).map(term => cleanString(term, { max: 200 }).toLowerCase()))].sort();
    const excerptTerms = evidenceTokenSet(excerpt);
    for (const term of matchedTerms) {
      if (!excerptTerms.has(term)) throw new Error(`matchEvidence term "${term}" is not present in its source excerpt.`);
    }
    return {
      sourceKind: cleanString(item.sourceKind, { max: 100 }),
      sourceResourceId: cleanString(item.sourceResourceId, { max: 500 }),
      sourceUrl: cleanString(item.sourceUrl, { max: 2_000 }),
      rowNumber: item.rowNumber == null ? null : (Number.isSafeInteger(Number(item.rowNumber)) ? Number(item.rowNumber) : null),
      excerpt,
      matchedTerms
    };
  });
}

function hasFoundationEvidence(foundation) {
  return cleanArray(foundation?.programDescriptions).length > 0
    || cleanArray(foundation?.historicalEvidence).length > 0
    || cleanArray(foundation?.qualifiedDoneeEvidence).length > 0;
}

function readinessFindings({ profile, request, foundation, matchedTerms, supportingEvidence, budgetTotalCents, amountCents }) {
  const codes = [];
  if (!profile.mission) codes.push('profile.mission_missing');
  if (!profile.activities.length) codes.push('profile.activities_missing');
  if (!profile.populations.length) codes.push('profile.populations_missing');
  if (!profile.geography.length) codes.push('profile.geography_missing');
  if (!profile.outcomes.length) codes.push('profile.outcomes_missing');
  if (!profile.evidence.length) codes.push('profile.evidence_missing');
  if (!request.objectives.length) codes.push('request.objectives_missing');
  if (!request.activities.length) codes.push('request.activities_missing');
  if (!request.outcomes.length) codes.push('request.outcomes_missing');
  if (!request.budget.length) codes.push('request.budget_missing');
  if (!request.evidence.length) codes.push('request.evidence_missing');
  if (request.budget.length && budgetTotalCents !== amountCents) codes.push('request.budget_total_mismatch');
  const evidencedTerms = new Set(supportingEvidence.flatMap(item => item.matchedTerms));
  if (!hasFoundationEvidence(foundation) && !matchedTerms.some(term => evidencedTerms.has(term))) codes.push('foundation.evidence_missing');
  if (!matchedTerms.length) codes.push('foundation.match_terms_missing');
  if (matchedTerms.length && matchedTerms.some(term => !evidencedTerms.has(term))) codes.push('foundation.match_evidence_incomplete');
  return codes.map(code => ({ code, message: findingMessages[code] }));
}

export function buildApplicationPackage({
  recipientOrganization = {},
  profile = {},
  fundingRequest = {},
  foundation = {},
  matchedTerms = [],
  matchEvidence = []
} = {}) {
  const amountCents = moneyToCents(fundingRequest.amountCad, 'amountCad');
  if (amountCents <= 0) throw new Error('amountCad must be positive.');
  const budget = normalizeBudget(fundingRequest.budget);
  const budgetTotalCents = budget.reduce((sum, line) => sum + line.amountCents, 0);
  const fitTerms = [...new Set(cleanArray(matchedTerms).map(term => term.toLowerCase()))].sort();
  const supportingEvidence = normalizeMatchEvidence(matchEvidence);

  const normalizedProfile = {
    version: Number(profile.version || 1),
    mission: cleanString(profile.mission),
    activities: cleanArray(profile.activities),
    populations: cleanArray(profile.populations),
    geography: cleanArray(profile.geography),
    outcomes: cleanArray(profile.outcomes),
    governance: canonicalValue(profile.governance || {}),
    financialSummary: canonicalValue(profile.financialSummary || {}),
    evidence: cleanArray(profile.evidence)
  };
  const normalizedRequest = {
    id: cleanString(fundingRequest.id, { max: 200 }),
    version: Number(fundingRequest.version || 1),
    title: cleanString(fundingRequest.title, { max: 500 }),
    purpose: cleanString(fundingRequest.purpose),
    amountCad: amountCents / 100,
    amountCents,
    objectives: cleanArray(fundingRequest.objectives),
    activities: cleanArray(fundingRequest.activities),
    outcomes: cleanArray(fundingRequest.outcomes),
    budget,
    budgetTotalCad: budgetTotalCents / 100,
    budgetTotalCents,
    geography: cleanArray(fundingRequest.geography),
    populations: cleanArray(fundingRequest.populations),
    evidence: cleanArray(fundingRequest.evidence)
  };
  const normalizedFoundation = {
    bn: cleanString(foundation.bn, { max: 20 }).toUpperCase().replace(/[\s-]/g, ''),
    name: cleanString(foundation.name, { max: 500 }),
    province: cleanString(foundation.province, { max: 3 }),
    designation: cleanString(foundation.designation, { max: 100 }),
    sourceYear: foundation.sourceYear == null ? null : Number(foundation.sourceYear),
    programDescriptions: cleanArray(foundation.programDescriptions),
    historicalEvidence: cleanArray(foundation.historicalEvidence || foundation.qualifiedDoneeEvidence)
  };

  const findings = readinessFindings({
    profile: normalizedProfile,
    request: normalizedRequest,
    foundation,
    matchedTerms: fitTerms,
    supportingEvidence,
    budgetTotalCents,
    amountCents
  });
  const readiness = { ready: findings.length === 0, findings };
  const packageSnapshot = {
    schemaVersion: 1,
    recipient: {
      organizationId: cleanString(recipientOrganization.id, { max: 200 }),
      legalName: cleanString(recipientOrganization.legalName || recipientOrganization.legal_name, { max: 500 }),
      organizationType: cleanString(recipientOrganization.organizationType || recipientOrganization.organization_type, { max: 100 }),
      businessNumber: cleanString(recipientOrganization.businessNumber || recipientOrganization.business_number, { max: 20 }),
      province: cleanString(recipientOrganization.province, { max: 3 })
    },
    profile: normalizedProfile,
    request: normalizedRequest,
    foundation: normalizedFoundation,
    fit: {
      matchedTerms: fitTerms,
      supportingEvidence,
      rationale: fitTerms.length
        ? `Shared recipient/foundation evidence terms: ${fitTerms.join(', ')}`
        : 'No shared evidence terms were confirmed.'
    },
    sources: {
      recipientEvidence: normalizedProfile.evidence,
      requestEvidence: normalizedRequest.evidence,
      foundationEvidence: supportingEvidence,
      foundationSourceYear: normalizedFoundation.sourceYear
    },
    readiness,
    filingBoundary: 'external_foundation_channel_required'
  };
  const packageHash = crypto.createHash('sha256').update(canonicalJson(packageSnapshot)).digest('hex');
  return { packageSnapshot, readiness, packageHash };
}

export function assertApplicationSourceVersions(application, {
  recipientOrgId,
  fundingRequestId,
  profileVersion,
  requestVersion
}) {
  const snapshot = application?.packageSnapshot;
  if (!snapshot) throw new Error('Application package snapshot is required.');
  if (snapshot.recipient?.organizationId !== recipientOrgId) throw new Error('Application recipient organization changed.');
  if (snapshot.request?.id !== fundingRequestId) throw new Error('Application funding request identity changed.');
  if (snapshot.profile?.version !== profileVersion) throw new Error('Recipient funding profile changed after this draft was prepared. Prepare a new application draft.');
  if (snapshot.request?.version !== requestVersion) throw new Error('Recipient funding request changed after this draft was prepared. Prepare a new application draft.');
  return true;
}

export function transitionApplication(application, nextStatus, input = {}, options = {}) {
  if (!application?.status) throw new Error('Application status is required.');
  if (terminalStatuses.has(application.status)) throw new Error(`Application is terminal in status ${application.status}.`);
  if (!allowedTransitions.get(application.status)?.has(nextStatus)) {
    throw new Error(`Invalid application transition ${application.status} -> ${nextStatus}.`);
  }

  const now = new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('Transition time is invalid.');
  const next = { ...application, status: nextStatus, updatedAt: now.toISOString() };

  if (nextStatus === 'ready') {
    if (input.packageHash !== application.packageHash) throw new Error('The application package hash does not match the current draft.');
    if (input.confirmation !== 'MARK APPLICATION READY') throw new Error('Exact readiness confirmation is required.');
    if (application.readiness?.findings?.length || application.readiness?.ready !== true) {
      throw new Error('Resolve all application readiness findings before marking it ready.');
    }
    next.readyAt = now.toISOString();
  }

  if (nextStatus === 'submitted') {
    const submissionChannel = cleanString(input.submissionChannel, { max: 200 });
    const externalSubmissionReference = cleanString(input.externalSubmissionReference, { max: 500 });
    if (!submissionChannel) throw new Error('Submission channel is required.');
    if (!externalSubmissionReference) throw new Error('External submission reference is required.');
    next.submissionChannel = submissionChannel;
    next.externalSubmissionReference = externalSubmissionReference;
    next.submittedAt = evidenceTimestamp(input.submittedAt, 'submittedAt', {
      earliest: application.readyAt,
      earliestLabel: 'became ready',
      now
    });
  }

  if (terminalStatuses.has(nextStatus)) {
    const rationale = cleanString(input.rationale, { max: 10_000 });
    if (!rationale) throw new Error('Application outcome rationale is required.');
    next.outcomeRationale = rationale;
    const earliest = nextStatus === 'withdrawn'
      ? application.submittedAt || application.readyAt || application.createdAt
      : application.submittedAt;
    next.decidedAt = evidenceTimestamp(input.decidedAt, 'decidedAt', {
      earliest,
      earliestLabel: application.submittedAt ? 'was submitted' : 'was created',
      now
    });
  }

  next.lastEvent = {
    idempotencyKey: cleanString(input.idempotencyKey, { max: 200 }) || null,
    fromStatus: application.status,
    toStatus: nextStatus,
    occurredAt: now.toISOString()
  };
  return next;
}
