export const CRA_LIST_URL = 'https://apps.cra-arc.gc.ca/ebci/hacc/srch/pub/dsplyBscSrch';

export const CRA_OBSERVED_STATUSES = Object.freeze([
  'registered',
  'revoked',
  'annulled',
  'suspended',
  'penalized',
  'unknown'
]);

export function normalizeCraObservedStatus(observedStatus) {
  const value = String(observedStatus || '').trim().toLowerCase();
  if (!CRA_OBSERVED_STATUSES.includes(value)) throw new Error(`Unsupported CRA observed status: ${observedStatus}`);
  if (value === 'registered') return { status: 'eligible', assuranceLevel: 'authoritative' };
  if (['revoked', 'annulled', 'suspended'].includes(value)) return { status: 'ineligible', assuranceLevel: 'authoritative' };
  if (value === 'penalized') return { status: 'needs_review', assuranceLevel: 'authoritative' };
  return { status: 'unknown', assuranceLevel: 'authoritative' };
}

export function screeningStatusFromT3010({ businessNumber, sourceYear }) {
  return {
    status: 'eligible',
    assuranceLevel: 'screening',
    source: 'open_canada_t3010',
    sourceRecordId: businessNumber,
    evidence: { sourceYear, limitation: 'Annual public filing data; not release-time legal-status verification.' }
  };
}

export function isReleaseEligibleStatusCheck(check, { now = new Date(), maxAgeHours = 24 } = {}) {
  if (!check || check.status !== 'eligible' || check.assuranceLevel !== 'authoritative') return false;
  const verifiedAt = new Date(check.verifiedAt);
  if (Number.isNaN(verifiedAt.getTime())) return false;
  const age = now.getTime() - verifiedAt.getTime();
  return age >= 0 && age <= maxAgeHours * 60 * 60 * 1000;
}
