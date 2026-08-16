import { DEFAULT_T3010_YEAR, OPEN_CANADA_CKAN_BASE, RESOURCE_KINDS, T3010_DATASET_IDS } from './constants.mjs';

function bilingualText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return [value.en, value.fr].filter(Boolean).join(' ');
  return String(value);
}

const MATCHERS = Object.freeze({
  identification: [/\bidentification\b/i, /ident_\d{4}/i],
  general_information: [/general information/i, /financial_section_a_b_and_c/i],
  financial_data: [/^financial data$/i, /financial_d_and_schedule_6/i],
  programs: [/charitable programs/i, /new_ongoing_programs/i],
  non_qualified_donees: [/non[- ]qualified donees/i, /non_qualified_donees/i],
  qualified_donees: [/(?<!non[- ])qualified donees/i, /qualified_donees/i],
  foundations: [/private\/public foundations/i, /schedule_1_foundations/i],
  disbursement_quota: [/disbursement quota/i, /schedule_8_dq/i],
  web_addresses: [/charity contact web addresses/i, /weburl_/i]
});

export function classifyResource(resource) {
  const label = [bilingualText(resource.name), bilingualText(resource.name_translated), resource.url, resource.description]
    .filter(Boolean).join(' ');

  // Test non-qualified before qualified so the substring cannot misclassify it.
  if (MATCHERS.non_qualified_donees.some(re => re.test(label))) return 'non_qualified_donees';
  for (const kind of RESOURCE_KINDS) {
    if (kind === 'non_qualified_donees') continue;
    if (MATCHERS[kind].some(re => re.test(label))) return kind;
  }
  return null;
}

export async function fetchOpenCanadaPackage({ year = DEFAULT_T3010_YEAR, datasetId, fetchImpl = fetch } = {}) {
  const id = datasetId || process.env.OPEN_CANADA_T3010_DATASET_ID || T3010_DATASET_IDS[year];
  if (!id) throw new Error(`No known T3010 Open Canada dataset id for year ${year}; pass --dataset-id or OPEN_CANADA_T3010_DATASET_ID`);
  const url = `${OPEN_CANADA_CKAN_BASE}/package_show?id=${encodeURIComponent(id)}`;
  const response = await fetchImpl(url, { headers: { 'user-agent': 'canadian-philanthropy-clearing-house/0.2 (+https://github.com/jordanlegare/clearing_house)' } });
  if (!response.ok) throw new Error(`Open Canada catalogue request failed: ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (!payload?.success || !payload.result) throw new Error('Open Canada catalogue returned an unsuccessful CKAN response');
  return { id, url, package: payload.result };
}

export function discoverT3010Resources(pkg) {
  const found = {};
  for (const resource of pkg.resources ?? []) {
    const kind = classifyResource(resource);
    if (!kind || found[kind]) continue;
    if (!/csv/i.test(String(resource.format ?? 'CSV')) && !/\.csv(?:$|\?)/i.test(String(resource.url ?? ''))) continue;
    found[kind] = { id: resource.id, name: bilingualText(resource.name), url: resource.url, format: resource.format ?? 'CSV' };
  }
  return found;
}
