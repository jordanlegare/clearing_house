const BN_RE = /^\d{9}RR\d{4}$/i;

export function normalizeBn(value) {
  const v = String(value ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return BN_RE.test(v) ? v : null;
}

const BN_KEYS = new Set([
  'bn', 'business_number', 'registration_number', 'charity_registration_number',
  'bn_registration_number', 'account_number', 'charity_bn'
]);

export function extractBn(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (BN_KEYS.has(key) || key === 'business_no' || key.startsWith('bn_')) {
      const bn = normalizeBn(value);
      if (bn) return bn;
    }
  }
  // Schema-drift fallback: CRA registered-charity BNs are distinctive enough to
  // identify from a row without relying on an exact column label.
  for (const value of Object.values(fields)) {
    const bn = normalizeBn(value);
    if (bn) return bn;
  }
  return null;
}

export function firstField(fields, patterns, { numeric = false } = {}) {
  for (const pattern of patterns) {
    for (const [key, value] of Object.entries(fields)) {
      if (!pattern.test(key)) continue;
      if (value === '' || value == null) continue;
      if (!numeric) return String(value).trim();
      const n = Number(String(value).replace(/[$,\s]/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return numeric ? null : '';
}

export function extractName(fields) {
  return firstField(fields, [
    /^charity_name$/, /^legal_name$/, /^organization_name$/, /^name$/, /charity.*name/, /donee.*name/, /grantee.*name/
  ]);
}

export function extractProvince(fields) {
  return firstField(fields, [/^province$/, /^prov$/, /province.*code/, /province/]).toUpperCase();
}

export function extractCity(fields) {
  return firstField(fields, [/^city$/, /municipality/, /city/]);
}

export function extractDesignation(fields) {
  return firstField(fields, [/designation/, /organization.*type/, /charity.*type/]);
}

export function numericFields(fields, keyPattern = /(dq|disbursement|property|asset|revenue|expenditure|amount|gift|grant)/i) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!keyPattern.test(key) || value === '' || value == null) continue;
    const n = Number(String(value).replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

export function normalizeT3010Record({ kind, rowNumber, fields, resource }) {
  return {
    bn: extractBn(fields),
    name: extractName(fields),
    rowNumber,
    kind,
    sourceResourceId: resource.id,
    sourceUrl: resource.url,
    fields
  };
}
