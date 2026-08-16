import { payloadDigest, buildAuditEntry } from '../security/audit.mjs';
import { PERMISSIONS, ROLES, requireOrgPermission } from '../security/rbac.mjs';

function moneyToCents(value) {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`Invalid CAD amount: ${value}`);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('CAD amount exceeds safe cent range.');
  return negative ? -cents : cents;
}

function centsCad(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('Cent amount must be an integer.');
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function roundedCad(cents) {
  return Math.round(cents / 100);
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers, rows) {
  return [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

function normalizeCountryEntry(value) {
  const text = String(value || '').trim();
  if (!/^[A-Z]{2}-.+/.test(text)) throw new Error(`Country entry must use the CRA code-name format, for example ES-Spain: ${text}`);
  return text;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function locationFromProfile(profile = {}, province = '') {
  const raw = profile.raw || {};
  const city = firstText(profile.city, profile.municipality, profile.address?.city, raw.city, raw.CITY, raw.city_name, raw.CITY_NAME);
  const prov = firstText(province, profile.province, profile.address?.province, raw.province, raw.PROVINCE);
  const country = firstText(profile.country, profile.address?.country, raw.country, raw.COUNTRY, prov ? 'Canada' : '');
  return { city, province: prov, country };
}

function accessibleFoundation(actor, foundationOrgId) {
  if (!actor?.id) throw new Error('Authentication is required.');
  if (!(actor.roles || []).includes(ROLES.SYSTEM_ADMIN)) requireOrgPermission(actor, foundationOrgId, PERMISSIONS.EXPORT_REPORTING);
}

async function appendAudit(repository, client, { actor, organizationId, action, resourceId, requestId, payload }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [742019301]);
  const previous = await client.query('SELECT entry_hmac FROM audit_log ORDER BY sequence DESC LIMIT 1');
  const occurredAt = new Date().toISOString();
  const entry = buildAuditEntry({
    key: repository.auditHmacKey,
    previousDigest: previous.rows[0]?.entry_hmac || '',
    occurredAt,
    actorUserId: actor?.id || '',
    organizationId,
    action,
    resourceType: action.startsWith('grant_reporting') ? 'grant' : 'fiscal_reporting_package',
    resourceId: String(resourceId),
    requestId: requestId || '',
    payload
  });
  await client.query(`
    INSERT INTO audit_log
      (occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,request_id,payload_digest,previous_digest,entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [occurredAt, actor?.id || null, organizationId, action,
    action.startsWith('grant_reporting') ? 'grant' : 'fiscal_reporting_package', String(resourceId), requestId || null,
    entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

export async function setGrantReportingMetadata(repository, actor, {
  grantId,
  nonCashCad = 0,
  activitiesOutsideCanada = null,
  countries = [],
  associatedCharity = null,
  designatedGiftCad = 0,
  idempotencyKey
}) {
  if (!idempotencyKey) throw new Error('idempotencyKey is required.');
  const grant = await repository.getGrant(grantId);
  if (!grant) throw new Error('Grant not found.');
  accessibleFoundation(actor, grant.foundationOrgId);
  const amountCents = moneyToCents(grant.amountCad);
  const nonCashCents = moneyToCents(nonCashCad);
  const designatedCents = moneyToCents(designatedGiftCad);
  if (nonCashCents < 0 || nonCashCents > amountCents) throw new Error('nonCashCad must be between 0 and the grant amount.');
  if (designatedCents < 0 || designatedCents > amountCents) throw new Error('designatedGiftCad must be between 0 and the grant amount.');
  const normalizedCountries = [...new Set((countries || []).map(normalizeCountryEntry))].sort();
  if (activitiesOutsideCanada === false && normalizedCountries.length) throw new Error('countries must be empty when activitiesOutsideCanada is false.');
  if (activitiesOutsideCanada === true && normalizedCountries.length === 0) throw new Error('At least one CRA country code-name entry is required for activities outside Canada.');
  if (grant.recipientType === 'qualified_donee' && associatedCharity === null) throw new Error('associatedCharity must be explicitly true or false for a qualified-donee gift.');
  if (grant.recipientType === 'non_qualified_donee' && activitiesOutsideCanada === null) throw new Error('activitiesOutsideCanada must be explicitly true or false for a non-qualified-donee grant.');
  if (grant.recipientType === 'non_qualified_donee' && designatedCents !== 0) throw new Error('designatedGiftCad applies only to gifts to qualified donees.');

  const payload = {
    grantId,
    nonCashCad: centsCad(nonCashCents),
    activitiesOutsideCanada,
    countries: normalizedCountries,
    associatedCharity,
    designatedGiftCad: centsCad(designatedCents)
  };
  const hash = payloadDigest(payload);
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const replay = (await client.query('SELECT * FROM grant_reporting_metadata_commands WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
    if (replay) {
      if (replay.grant_id !== grantId || replay.payload_hash !== hash) throw new Error('idempotencyKey was already used for different reporting metadata.');
      const existing = (await client.query('SELECT * FROM grant_reporting_metadata WHERE grant_id=$1', [grantId])).rows[0];
      await client.query('COMMIT');
      return existing;
    }
    const { rows } = await client.query(`
      INSERT INTO grant_reporting_metadata
        (grant_id,non_cash_cad,activities_outside_canada,countries,associated_charity,designated_gift_cad,updated_by,updated_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,now())
      ON CONFLICT (grant_id) DO UPDATE SET
        non_cash_cad=EXCLUDED.non_cash_cad,
        activities_outside_canada=EXCLUDED.activities_outside_canada,
        countries=EXCLUDED.countries,
        associated_charity=EXCLUDED.associated_charity,
        designated_gift_cad=EXCLUDED.designated_gift_cad,
        updated_by=EXCLUDED.updated_by,
        updated_at=now()
      RETURNING *
    `, [grantId, centsCad(nonCashCents), activitiesOutsideCanada, JSON.stringify(normalizedCountries), associatedCharity, centsCad(designatedCents), actor.id]);
    await client.query(`INSERT INTO grant_reporting_metadata_commands (idempotency_key,grant_id,payload_hash) VALUES ($1,$2,$3)`, [idempotencyKey, grantId, hash]);
    await appendAudit(repository, client, {
      actor,
      organizationId: grant.foundationOrgId,
      action: 'grant_reporting.metadata_set',
      resourceId: grantId,
      requestId: idempotencyKey,
      payload
    });
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function periodRows(repository, foundationOrgId, fiscalPeriodStart, fiscalPeriodEnd) {
  const { rows } = await repository.pool.query(`
    SELECT g.id AS grant_id,g.recipient_org_id,g.recipient_type,g.purpose,
           p.amount_cad,p.recorded_at,p.external_reference,
           o.business_number,o.legal_name,o.province,o.public_profile,
           m.non_cash_cad,m.activities_outside_canada,m.countries,m.associated_charity,m.designated_gift_cad
    FROM grants g
    JOIN payment_intents p ON p.grant_id=g.id AND p.status='recorded'
    JOIN organizations o ON o.id=g.recipient_org_id
    LEFT JOIN grant_reporting_metadata m ON m.grant_id=g.id
    WHERE g.foundation_org_id=$1
      AND p.recorded_at >= $2::date
      AND p.recorded_at < ($3::date + interval '1 day')
    ORDER BY p.recorded_at,g.id
  `, [foundationOrgId, fiscalPeriodStart, fiscalPeriodEnd]);
  return rows;
}

function buildPackagePayload({ foundation, fiscalPeriodStart, fiscalPeriodEnd, rows }) {
  const reviewFlags = [];
  const qd = [];
  const nqd = [];
  for (const row of rows) {
    const amountCents = moneyToCents(row.amount_cad);
    const nonCashCents = moneyToCents(row.non_cash_cad ?? 0);
    if (nonCashCents > amountCents) reviewFlags.push({ grantId: row.grant_id, code: 'non_cash_exceeds_total' });
    const record = {
      grantId: row.grant_id,
      recipientOrgId: row.recipient_org_id,
      recipientName: row.legal_name,
      businessNumber: row.business_number || '',
      purpose: row.purpose,
      amountCents,
      nonCashCents,
      cashCents: amountCents - nonCashCents,
      recordedAt: row.recorded_at?.toISOString?.() || row.recorded_at,
      externalReference: row.external_reference || '',
      province: row.province || '',
      profile: row.public_profile || {},
      activitiesOutsideCanada: row.activities_outside_canada,
      countries: Array.isArray(row.countries) ? row.countries : [],
      associatedCharity: row.associated_charity,
      designatedGiftCents: moneyToCents(row.designated_gift_cad ?? 0)
    };
    if (row.recipient_type === 'qualified_donee') qd.push(record);
    else if (row.recipient_type === 'non_qualified_donee') nqd.push(record);
    else reviewFlags.push({ grantId: row.grant_id, code: 'unknown_recipient_type', recipientType: row.recipient_type });
  }

  const qdGroups = new Map();
  for (const item of qd) {
    const key = item.recipientOrgId;
    const group = qdGroups.get(key) || { ...item, amountCents: 0, nonCashCents: 0, designatedGiftCents: 0, grantIds: [] };
    group.amountCents += item.amountCents;
    group.nonCashCents += item.nonCashCents;
    group.designatedGiftCents += item.designatedGiftCents;
    group.grantIds.push(item.grantId);
    if (item.associatedCharity === null) reviewFlags.push({ grantId: item.grantId, code: 'associated_charity_not_confirmed' });
    else if (group.associatedCharity !== null && group.associatedCharity !== item.associatedCharity) reviewFlags.push({ grantId: item.grantId, code: 'associated_charity_inconsistent' });
    group.associatedCharity = item.associatedCharity;
    qdGroups.set(key, group);
  }
  const t1236Rows = [...qdGroups.values()].map(group => {
    const location = locationFromProfile(group.profile, group.province);
    if (!location.city) reviewFlags.push({ recipientOrgId: group.recipientOrgId, code: 't1236_city_missing' });
    if (!location.province && location.country === 'Canada') reviewFlags.push({ recipientOrgId: group.recipientOrgId, code: 't1236_province_missing' });
    return {
      organizationName: group.recipientName,
      associatedCharity: group.associatedCharity,
      businessNumber: group.businessNumber,
      cityProvince: [location.city, location.province].filter(Boolean).join(', '),
      country: location.country,
      nonCashGiftsCad: centsCad(group.nonCashCents),
      totalGiftsCad: centsCad(group.amountCents),
      designatedGiftCad: centsCad(group.designatedGiftCents),
      grantIds: group.grantIds.sort()
    };
  }).sort((a,b) => a.organizationName.localeCompare(b.organizationName));

  const nqdTotals = new Map();
  for (const item of nqd) nqdTotals.set(item.recipientOrgId, (nqdTotals.get(item.recipientOrgId) || 0) + item.amountCents);
  const largeNqdIds = new Set([...nqdTotals.entries()].filter(([, cents]) => cents > 500000).map(([id]) => id));
  const smallNqdIds = new Set([...nqdTotals.entries()].filter(([, cents]) => cents <= 500000).map(([id]) => id));
  for (const item of nqd) {
    if (item.activitiesOutsideCanada === null) reviewFlags.push({ grantId: item.grantId, code: 'nqd_activity_location_not_confirmed' });
    if (item.activitiesOutsideCanada === true && item.countries.length === 0) reviewFlags.push({ grantId: item.grantId, code: 'nqd_countries_missing' });
  }
  const t1441Rows = nqd.filter(item => largeNqdIds.has(item.recipientOrgId)).map(item => ({
    granteeName: item.recipientName,
    purpose: item.purpose,
    nonCashDisbursementsCad: centsCad(item.nonCashCents),
    cashDisbursementsCad: centsCad(item.cashCents),
    countriesOutsideCanada: item.activitiesOutsideCanada ? item.countries.join(', ') : '',
    grantId: item.grantId
  }));

  const qdTotal = qd.reduce((sum, item) => sum + item.amountCents, 0);
  const nqdTotal = nqd.reduce((sum, item) => sum + item.amountCents, 0);
  const smallNqdTotal = [...nqdTotals.entries()].filter(([id]) => smallNqdIds.has(id)).reduce((sum, [, cents]) => sum + cents, 0);
  const designatedGiftTotal = qd.reduce((sum, item) => sum + item.designatedGiftCents, 0);
  const payload = {
    schemaVersion: '2026-08-16.1',
    basis: 'recorded external payment references within the stated fiscal period; review against the charity accounting method before filing',
    foundation: {
      id: foundation.id,
      name: foundation.legal_name,
      businessNumber: foundation.business_number
    },
    fiscalPeriod: { start: fiscalPeriodStart, end: fiscalPeriodEnd },
    t3010: {
      questionC3QualifiedDoneeGifts: qdTotal > 0,
      line5840NqdGrants: nqdTotal > 0,
      line5841AnyNqdOver5000: largeNqdIds.size > 0,
      line5842NqdCountAtOrBelow5000: smallNqdIds.size,
      line5843NqdAmountAtOrBelow5000Cad: roundedCad(smallNqdTotal),
      line5045NqdGrantsCad: roundedCad(nqdTotal),
      line5050QualifiedDoneeGiftsCad: roundedCad(qdTotal),
      schedule8Line850Cad: roundedCad(nqdTotal),
      schedule8Line855Cad: roundedCad(qdTotal),
      designatedGiftsCad: roundedCad(designatedGiftTotal),
      note: 'T3010 financial lines are rounded to the nearest Canadian dollar. Line 5100 and Schedule 8 line 860 require other financial/charitable expenditure inputs not owned by this grant ledger.'
    },
    t1236: {
      required: qdTotal > 0,
      totalOrganizations: t1236Rows.length,
      rows: t1236Rows,
      uploadCsv: csv(
        ['Name of organization','Associated charity','BN/Registration number','City and Prov/Terr','Country','Amount of non-cash gifts CAD','Total amount of gifts CAD','Designated gift CAD'],
        t1236Rows.map(row => [row.organizationName, row.associatedCharity === null ? '' : row.associatedCharity ? 'Yes' : 'No', row.businessNumber, row.cityProvince, row.country, row.nonCashGiftsCad, row.totalGiftsCad, row.designatedGiftCad])
      )
    },
    t1441: {
      required: largeNqdIds.size > 0,
      totalGranteesOver5000: largeNqdIds.size,
      rows: t1441Rows,
      uploadCsv: csv(
        ['Name of grantee','Purpose of grant','Amount of non-cash disbursements CAD','Amount of cash disbursements CAD','Countries where grant activities were carried on'],
        t1441Rows.map(row => [row.granteeName, row.purpose, row.nonCashDisbursementsCad, row.cashDisbursementsCad, row.countriesOutsideCanada])
      )
    },
    ledger: {
      paidGrantCount: rows.length,
      qualifiedDoneeTotalCad: centsCad(qdTotal),
      nonQualifiedDoneeTotalCad: centsCad(nqdTotal),
      totalQualifyingDisbursementsCad: centsCad(qdTotal + nqdTotal)
    },
    reviewFlags
  };
  payload.filingReady = reviewFlags.length === 0;
  payload.packageHash = payloadDigest({ ...payload, packageHash: undefined });
  return payload;
}

export async function previewFiscalReportingPackage(repository, actor, { foundationOrgId, fiscalPeriodStart, fiscalPeriodEnd }) {
  accessibleFoundation(actor, foundationOrgId);
  const foundation = await repository.getOrganization(foundationOrgId);
  if (!foundation || foundation.organization_type !== 'foundation') throw new Error('Foundation organization not found.');
  if (!foundation.business_number) throw new Error('Foundation business number is required for CRA reporting.');
  const rows = await periodRows(repository, foundationOrgId, fiscalPeriodStart, fiscalPeriodEnd);
  return buildPackagePayload({ foundation, fiscalPeriodStart, fiscalPeriodEnd, rows });
}

export async function prepareFiscalReportingPackage(repository, actor, args) {
  if (!args.idempotencyKey) throw new Error('idempotencyKey is required.');
  const payload = await previewFiscalReportingPackage(repository, actor, args);
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const replay = (await client.query('SELECT * FROM fiscal_reporting_packages WHERE preparation_idempotency_key=$1', [args.idempotencyKey])).rows[0];
    if (replay) {
      if (replay.foundation_org_id !== args.foundationOrgId || replay.package_hash !== payload.packageHash) throw new Error('idempotencyKey was already used for a different fiscal reporting package.');
      await client.query('COMMIT');
      return replay;
    }
    const { rows } = await client.query(`
      INSERT INTO fiscal_reporting_packages
        (foundation_org_id,fiscal_period_start,fiscal_period_end,package_hash,payload,filing_ready,prepared_by,preparation_idempotency_key)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      ON CONFLICT (foundation_org_id,fiscal_period_start,fiscal_period_end,package_hash) DO UPDATE SET package_hash=EXCLUDED.package_hash
      RETURNING *
    `, [args.foundationOrgId, args.fiscalPeriodStart, args.fiscalPeriodEnd, payload.packageHash, JSON.stringify(payload), payload.filingReady, actor.id, args.idempotencyKey]);
    await appendAudit(repository, client, {
      actor,
      organizationId: args.foundationOrgId,
      action: 'fiscal_reporting_package.prepared',
      resourceId: rows[0].id,
      requestId: args.idempotencyKey,
      payload: { packageHash: payload.packageHash, fiscalPeriodStart: args.fiscalPeriodStart, fiscalPeriodEnd: args.fiscalPeriodEnd, filingReady: payload.filingReady }
    });
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function getFiscalReportingPackage(repository, actor, packageId) {
  const { rows } = await repository.pool.query('SELECT * FROM fiscal_reporting_packages WHERE id=$1', [packageId]);
  const row = rows[0];
  if (!row) throw new Error('Fiscal reporting package not found.');
  accessibleFoundation(actor, row.foundation_org_id);
  return row;
}
