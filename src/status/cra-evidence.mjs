const REVOCATIONS_URL = 'https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/revoking-registered-status/list-published-revocations-charities-oqd.html';
const CHARITY_LIST_URL = 'https://apps.cra-arc.gc.ca/ebci/hacc/srch/pub/dsplyBscSrch?request_locale=en';

export async function checkCraPublicEvidence({ businessNumber, t3010Profile = null, fetchImpl = fetch } = {}) {
  const bn = String(businessNumber || '').toUpperCase().replace(/[\s-]/g, '');
  if (!bn) throw new Error('businessNumber is required.');
  const response = await fetchImpl(REVOCATIONS_URL, { headers: { accept: 'text/html' } });
  if (!response.ok) throw new Error(`CRA published-revocations source failed: ${response.status}`);
  const html = (await response.text()).toUpperCase();
  const revocationEvidenceFound = html.includes(bn);
  return {
    businessNumber: bn,
    checkedAt: new Date().toISOString(),
    latestT3010Present: Boolean(t3010Profile),
    latestT3010SourceYear: t3010Profile?.sourceYear ?? null,
    revocationEvidenceFound,
    status: revocationEvidenceFound ? 'revocation_evidence_found' : 'not_determined',
    authoritativeSearchUrl: CHARITY_LIST_URL,
    revocationsSourceUrl: REVOCATIONS_URL,
    warning: 'Absence from the published-revocations page is not proof of current registration. Record a separate current eligibility/status verification before payment authorization.'
  };
}
