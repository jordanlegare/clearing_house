import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertApplicationSourceVersions,
  buildApplicationPackage,
  flattenApprovedText,
  jsonStringLeavesWithin,
  moneyToCents,
  transitionApplication
} from '../src/applications/package.mjs';

const completeInput = {
  recipientOrganization: {
    id: '00000000-0000-4000-8000-000000000001',
    legalName: 'Community Kitchen',
    organizationType: 'registered_charity',
    businessNumber: '222222222RR0001',
    province: 'ON'
  },
  profile: {
    version: 2,
    mission: 'Improve food security',
    activities: ['Community meals'],
    populations: ['Low-income households'],
    geography: ['Toronto'],
    outcomes: [{ name: 'Meals served', target: 12000 }],
    governance: { boardOversight: true },
    financialSummary: { fiscalYear: 2025, revenueCad: 500000 },
    evidence: [{ label: '2025 annual report', url: 'https://example.ca/report' }]
  },
  fundingRequest: {
    id: '00000000-0000-4000-8000-000000000002',
    version: 1,
    title: 'Refrigerated truck',
    purpose: 'Purchase a refrigerated delivery truck',
    amountCad: 85000,
    objectives: ['Recover more surplus food'],
    activities: ['Purchase and deploy truck'],
    outcomes: [{ name: 'Food recovered kg', target: 200000 }],
    budget: [{ label: 'Truck', amountCad: 85000 }],
    geography: ['Toronto'],
    populations: ['Low-income households'],
    evidence: [{ label: 'Dealer quote', reference: 'quote-2026-08' }]
  },
  foundation: {
    bn: '123456789RR0001',
    name: 'Example Foundation',
    province: 'ON',
    sourceYear: 2024,
    designation: 'private_foundation',
    programDescriptions: ['Food security equipment and transportation']
  },
  matchedTerms: ['transportation', 'food', 'security'],
  matchEvidence: [{
    sourceKind: 'identification',
    sourceResourceId: 'identification-2024',
    sourceUrl: 'https://example.ca/t3010-identification.csv',
    rowNumber: 42,
    excerpt: 'Public Food Security Transportation Foundation',
    matchedTerms: ['food', 'security', 'transportation']
  }]
};

test('approved matching text contains leaf text, never JSON structure or numeric targets', () => {
  const flattened = flattenApprovedText({
    mission: 'Improve food security',
    outcomes: [{ name: 'Meals served', target: 12_000 }],
    governance: { boardOversight: true }
  });

  assert.equal(flattened, 'Improve food security Meals served');
  assert.doesNotMatch(flattened, /mission|outcomes|name|target|governance|12000|true/i);
  assert.equal(jsonStringLeavesWithin({ outcome: 'x'.repeat(10_000) }), true);
  assert.equal(jsonStringLeavesWithin({ outcome: 'x'.repeat(10_001) }), false);
});

test('readiness requires retained source evidence for every claimed match term', () => {
  const built = buildApplicationPackage({
    ...completeInput,
    matchEvidence: [{ ...completeInput.matchEvidence[0], matchedTerms: ['food'], excerpt: 'Public Food Foundation' }]
  });

  assert.equal(built.readiness.ready, false);
  assert.ok(built.readiness.findings.some(finding => finding.code === 'foundation.match_evidence_incomplete'));
  assert.throws(() => buildApplicationPackage({
    ...completeInput,
    matchEvidence: [{ ...completeInput.matchEvidence[0], matchedTerms: ['security'], excerpt: 'Public Food Foundation' }]
  }), /evidence.*security.*excerpt/i);
});

test('complete recipient facts produce a ready deterministic package', () => {
  const built = buildApplicationPackage(completeInput);
  const reordered = buildApplicationPackage({
    ...completeInput,
    matchedTerms: ['security', 'transportation', 'food'],
    profile: { ...completeInput.profile, activities: [...completeInput.profile.activities] }
  });

  assert.equal(built.readiness.ready, true);
  assert.deepEqual(built.readiness.findings, []);
  assert.match(built.packageHash, /^[a-f0-9]{64}$/);
  assert.equal(built.packageHash, reordered.packageHash);
  assert.equal(built.packageSnapshot.schemaVersion, 1);
  assert.equal(built.packageSnapshot.filingBoundary, 'external_foundation_channel_required');
  assert.deepEqual(built.packageSnapshot.fit.matchedTerms, ['food', 'security', 'transportation']);
  assert.deepEqual(built.packageSnapshot.fit.supportingEvidence, completeInput.matchEvidence);
  assert.equal(built.packageSnapshot.request.amountCents, 8_500_000);
  assert.notEqual(built.packageHash, buildApplicationPackage({
    ...completeInput,
    matchEvidence: [{ ...completeInput.matchEvidence[0], excerpt: 'Private Food Security Transportation Foundation' }]
  }).packageHash);
});

test('readiness reports missing recipient facts instead of inventing them', () => {
  const built = buildApplicationPackage({
    ...completeInput,
    profile: { version: 1, mission: '', activities: [], populations: [], geography: [], outcomes: [], evidence: [] },
    fundingRequest: { ...completeInput.fundingRequest, objectives: [], budget: [{ label: 'Truck', amountCad: 84000 }], evidence: [] },
    foundation: { ...completeInput.foundation, programDescriptions: [] },
    matchedTerms: []
  });

  assert.equal(built.readiness.ready, false);
  assert.deepEqual(built.readiness.findings.map(finding => finding.code), [
    'profile.mission_missing',
    'profile.activities_missing',
    'profile.populations_missing',
    'profile.geography_missing',
    'profile.outcomes_missing',
    'profile.evidence_missing',
    'request.objectives_missing',
    'request.evidence_missing',
    'request.budget_total_mismatch',
    'foundation.evidence_missing',
    'foundation.match_terms_missing'
  ]);
});

test('application amounts and budget lines must be cent-exact', () => {
  assert.equal(moneyToCents(85_000.25, 'amountCad'), 8_500_025);
  assert.throws(() => moneyToCents(10.001, 'amountCad'), /fractions of a cent/);
  assert.throws(() => buildApplicationPackage({
    ...completeInput,
    fundingRequest: { ...completeInput.fundingRequest, amountCad: 85_000.001 }
  }), /fractions of a cent/);
});

test('application lifecycle requires an unchanged ready package and external submission evidence', () => {
  const built = buildApplicationPackage(completeInput);
  const draft = {
    id: '00000000-0000-4000-8000-000000000003',
    status: 'draft',
    packageHash: built.packageHash,
    readiness: built.readiness
  };

  assert.throws(() => transitionApplication(draft, 'ready', {
    packageHash: '0'.repeat(64), confirmation: 'MARK APPLICATION READY'
  }), /package hash/i);
  assert.throws(() => transitionApplication(draft, 'ready', {
    packageHash: built.packageHash, confirmation: 'yes'
  }), /confirmation/i);

  const ready = transitionApplication(draft, 'ready', {
    packageHash: built.packageHash,
    confirmation: 'MARK APPLICATION READY',
    idempotencyKey: 'ready-application-1'
  }, { now: '2026-08-16T20:00:00.000Z' });
  assert.equal(ready.status, 'ready');

  assert.throws(() => transitionApplication(ready, 'submitted', {
    submissionChannel: 'foundation_portal', submittedAt: '2026-08-16T20:05:00.000Z'
  }), /external submission reference/i);

  const submitted = transitionApplication(ready, 'submitted', {
    submissionChannel: 'foundation_portal',
    externalSubmissionReference: 'foundation-portal-2026-001',
    submittedAt: '2026-08-16T20:05:00.000Z',
    idempotencyKey: 'submit-application-1'
  }, { now: '2026-08-16T20:06:00.000Z' });
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.externalSubmissionReference, 'foundation-portal-2026-001');

  const awarded = transitionApplication(submitted, 'awarded', {
    rationale: 'Foundation award letter received.',
    decidedAt: '2026-09-20T12:00:00.000Z',
    idempotencyKey: 'award-application-1'
  }, { now: '2026-09-20T12:01:00.000Z' });
  assert.equal(awarded.status, 'awarded');
  assert.throws(() => transitionApplication(awarded, 'declined', { rationale: 'changed' }), /terminal/i);
});

test('submission and decision evidence must be chronological and not future-dated', () => {
  const built = buildApplicationPackage(completeInput);
  const ready = transitionApplication({
    status: 'draft', packageHash: built.packageHash, readiness: built.readiness
  }, 'ready', {
    packageHash: built.packageHash,
    confirmation: 'MARK APPLICATION READY'
  }, { now: '2026-08-16T20:00:00.000Z' });

  assert.throws(() => transitionApplication(ready, 'submitted', {
    submissionChannel: 'foundation_portal',
    externalSubmissionReference: 'portal-1',
    submittedAt: '2026-08-16T19:59:00.000Z'
  }, { now: '2026-08-16T20:01:00.000Z' }), /before.*ready/i);
  assert.throws(() => transitionApplication(ready, 'submitted', {
    submissionChannel: 'foundation_portal',
    externalSubmissionReference: 'portal-1',
    submittedAt: '2026-08-16T20:07:00.000Z'
  }, { now: '2026-08-16T20:01:00.000Z' }), /future/i);

  const submitted = transitionApplication(ready, 'submitted', {
    submissionChannel: 'foundation_portal',
    externalSubmissionReference: 'portal-1',
    submittedAt: '2026-08-16T20:01:00.000Z'
  }, { now: '2026-08-16T20:02:00.000Z' });
  assert.throws(() => transitionApplication(submitted, 'declined', {
    rationale: 'Decision received.',
    decidedAt: '2026-08-16T20:00:30.000Z'
  }, { now: '2026-08-16T20:03:00.000Z' }), /before.*submitted/i);
});

test('incomplete packages cannot become ready and illegal transitions fail closed', () => {
  const incomplete = buildApplicationPackage({ ...completeInput, matchedTerms: [] });
  const draft = { status: 'draft', packageHash: incomplete.packageHash, readiness: incomplete.readiness };

  assert.throws(() => transitionApplication(draft, 'ready', {
    packageHash: incomplete.packageHash,
    confirmation: 'MARK APPLICATION READY'
  }), /readiness findings/i);
  assert.throws(() => transitionApplication(draft, 'submitted', {}), /invalid application transition/i);
});

test('ready validation rejects drafts whose recipient sources changed', () => {
  const built = buildApplicationPackage(completeInput);
  const application = { packageSnapshot: built.packageSnapshot };
  assert.equal(assertApplicationSourceVersions(application, {
    recipientOrgId: completeInput.recipientOrganization.id,
    fundingRequestId: completeInput.fundingRequest.id,
    profileVersion: 2,
    requestVersion: 1
  }), true);
  assert.throws(() => assertApplicationSourceVersions(application, {
    recipientOrgId: completeInput.recipientOrganization.id,
    fundingRequestId: completeInput.fundingRequest.id,
    profileVersion: 3,
    requestVersion: 1
  }), /profile changed/i);
  assert.throws(() => assertApplicationSourceVersions(application, {
    recipientOrgId: completeInput.recipientOrganization.id,
    fundingRequestId: completeInput.fundingRequest.id,
    profileVersion: 2,
    requestVersion: 2
  }), /funding request changed/i);
});
