export const OPEN_CANADA_CKAN_BASE = 'https://open.canada.ca/data/api/3/action';

// CRA List of charities catalogue records verified on Open Government Canada.
// Override with --dataset-id / OPEN_CANADA_T3010_DATASET_ID when a newer year is published.
export const T3010_DATASET_IDS = Object.freeze({
  2022: 'b2acb3be-c720-4329-a8c0-d4d36c8db61e',
  2023: '05b3abd0-e70f-4b3b-a9c5-acc436bd15b6',
  2024: '80c00cdb-1358-415c-bb8b-0de7f12675b8'
});

export const DEFAULT_T3010_YEAR = 2024;

export const RESOURCE_KINDS = Object.freeze([
  'identification',
  'general_information',
  'financial_data',
  'programs',
  'qualified_donees',
  'non_qualified_donees',
  'foundations',
  'disbursement_quota',
  'web_addresses'
]);
