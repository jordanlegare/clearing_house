const REVOCATIONS_URL = 'https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/revoking-registered-status/list-published-revocations-charities-oqd.html';
const CHARITY_LIST_URL = 'https://apps.cra-arc.gc.ca/ebci/hacc/srch/pub/dsplyBscSrch?request_locale=en';

function normalizeBn(value) {
  return String(value || '').toUpperCase().replace(/[\s-]/g, '');
}

export async function fetchCraPublishedRevocations({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(REVOCATIONS_URL, { headers: { accept: 'text/html' } });
  if (!response.ok) throw new Error(`CRA published-revocations source failed: ${response.status}`);
  return {
    checkedAt: new Date().toISOString(),
    sourceUrl: REVOCATIONS_URL,
    htmlUpper: (await response.text()).toUpperCase()
  };
}

export function evaluateCraPublicEvidence({ businessNumber, t3010Profile = null, revocations }) {
  const bn = normalizeBn(businessNumber);
  if (!bn) throw new Error('businessNumber is required.');
  if (!revocations?.htmlUpper) throw new Error('Published-revocations evidence is required.');
  const revocationEvidenceFound = revocations.htmlUpper.includes(bn);
  return {
    businessNumber: bn,
    checkedAt: revocations.checkedAt,
    latestT3010Present: Boolean(t3010Profile),
    latestT3010SourceYear: t3010Profile?.sourceYear ?? null,
    revocationEvidenceFound,
    status: revocationEvidenceFound ? 'revocation_evidence_found' : 'not_determined',
    authoritativeSearchUrl: CHARITY_LIST_URL,
    revocationsSourceUrl: revocations.sourceUrl || REVOCATIONS_URL,
    warning: 'Absence from the published-revocations page is not proof of current registration. Confirm current status in the CRA List of charities before payment authorization.'
  };
}

export async function checkCraPublicEvidenceBulk({ organizations = [], fetchImpl = fetch } = {}) {
  if (!organizations.length) return [];
  const revocations = await fetchCraPublishedRevocations({ fetchImpl });
  return organizations.map(item => evaluateCraPublicEvidence({
    businessNumber: item.businessNumber,
    t3010Profile: item.t3010Profile || null,
    revocations
  }));
}

export async function checkCraPublicEvidence({ businessNumber, t3010Profile = null, fetchImpl = fetch } = {}) {
  const [result] = await checkCraPublicEvidenceBulk({
    organizations: [{ businessNumber, t3010Profile }],
    fetchImpl
  });
  return result;
}
