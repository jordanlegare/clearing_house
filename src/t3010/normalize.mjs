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

export function normalizeCanadianPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function normalizeEmail(value) {
  let text = String(value ?? '').trim();
  if (/^mailto:/i.test(text)) text = text.slice(7).split('?')[0];
  try { text = decodeURIComponent(text); } catch { /* retain original text */ }
  text = text.trim();
  if (!text || text.length > 254 || /[\s<>\u0000-\u001f\u007f]/.test(text)) return null;
  const parts = text.split('@');
  if (parts.length !== 2) return null;
  const [localRaw, domainRaw] = parts;
  if (!localRaw || localRaw.length > 64 || localRaw.startsWith('.') || localRaw.endsWith('.') || localRaw.includes('..')) return null;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localRaw)) return null;
  let domain = domainRaw.toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
  return `${localRaw.toLowerCase()}@${domain}`;
}

export function extractPhoneCandidates(...fieldSets) {
  const candidates = [];
  const seen = new Set();
  for (const fields of fieldSets.filter(Boolean)) {
    for (const [key, raw] of Object.entries(fields)) {
      const normalizedKey = String(key).toLowerCase();
      if (/fax/.test(normalizedKey)) continue;
      const keyLooksPhone = /(phone|telephone|tel_|_tel|contact.*number|number.*contact)/i.test(normalizedKey);
      if (!keyLooksPhone) continue;
      const phone = normalizeCanadianPhone(raw);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      candidates.push({ channel: 'sms', destination: phone, sourceKey: key, sourceValue: String(raw) });
      candidates.push({ channel: 'voice', destination: phone, sourceKey: key, sourceValue: String(raw) });
    }
  }
  return candidates;
}

export function extractEmailCandidates(...fieldSets) {
  const candidates = [];
  const seen = new Set();
  const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/ig;
  for (const fields of fieldSets.filter(Boolean)) {
    for (const [key, raw] of Object.entries(fields)) {
      const normalizedKey = String(key).toLowerCase();
      if (!/(email|e_mail|e-mail|courriel|mail.*address|contact.*mail)/i.test(normalizedKey)) continue;
      for (const match of String(raw ?? '').matchAll(emailPattern)) {
        const email = normalizeEmail(match[0]);
        if (!email || seen.has(email)) continue;
        seen.add(email);
        candidates.push({ channel: 'email', destination: email, sourceKey: key, sourceValue: String(raw) });
      }
    }
  }
  return candidates;
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

const T3010_FINANCIAL_LINES = Object.freeze({
  totalAssets: '4200',
  totalLiabilities: '4350',
  receiptedDonations: '4500',
  totalRevenue: '4700',
  totalExpenditures: '4950',
  charitableProgramExpenditures: '5000',
  managementAdministrationExpenditures: '5010',
  fundraisingExpenditures: '5020',
  otherExpenditures: '5040',
  grantsToNonQualifiedDonees: '5045',
  giftsToQualifiedDonees: '5050',
  totalExpendituresIncludingQualifyingDisbursements: '5100'
});

function numericValue(value) {
  if (value === '' || value == null) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function findLineField(fields, line) {
  if (Object.prototype.hasOwnProperty.call(fields, line)) return [line, fields[line]];
  const direct = `line_${line}`;
  if (Object.prototype.hasOwnProperty.call(fields, direct)) return [direct, fields[direct]];
  const pattern = new RegExp(`(?:^|_)${line}(?:_|$)`);
  for (const [key, value] of Object.entries(fields)) if (pattern.test(key)) return [key, value];
  return null;
}

export function extractT3010FinancialSignals(fields = {}) {
  const signals = {};
  const evidence = {};
  for (const [name, line] of Object.entries(T3010_FINANCIAL_LINES)) {
    const match = findLineField(fields, line);
    if (!match) continue;
    const [sourceKey, raw] = match;
    const value = numericValue(raw);
    if (value == null) continue;
    signals[name] = value;
    evidence[name] = { line, sourceKey, value };
  }
  return { signals, evidence };
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
