import { buildAuditEntry } from '../security/audit.mjs';
import { PERMISSIONS, requireOrgPermission, scopedActor } from '../security/rbac.mjs';
import { GRANT_STATES, transitionGrant } from '../workflow/grant_lifecycle.mjs';
import { classifyGrantReporting } from './reporting.mjs';
import { previewFiscalReportingPackage } from './fiscal_package.mjs';

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

function asIso(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('submittedAt must be a valid timestamp.');
  return date.toISOString();
}

function fiscalYearFromEnd(end) {
  const match = String(end || '').match(/^(\d{4})-\d{2}-\d{2}$/);
  if (!match) throw new Error('Fiscal package has an invalid fiscal-period end date.');
  return Number(match[1]);
}

async function appendAudit(repository, client, { actor, organizationId, action, resourceType, resourceId, requestId, payload }) {
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
    resourceType,
    resourceId: String(resourceId),
    requestId: requestId || '',
    payload
  });
  await client.query(`
    INSERT INTO audit_log
      (occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,request_id,payload_digest,previous_digest,entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [occurredAt, actor?.id || null, organizationId, action, resourceType, String(resourceId), requestId || null,
    entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

function summarizeSubmission(row) {
  return {
    id: row.id,
    packageId: row.package_id,
    foundationOrgId: row.foundation_org_id,
    packageHash: row.package_hash,
    externalSubmissionReference: row.external_submission_reference,
    submittedAt: row.submitted_at?.toISOString?.() || row.submitted_at,
    recordedBy: row.recorded_by,
    grantCount: Number(row.grant_count),
    createdAt: row.created_at?.toISOString?.() || row.created_at
  };
}

async function currentPeriodRows(client, packageRow) {
  const { rows } = await client.query(`
    SELECT g.id,g.foundation_org_id,g.recipient_org_id,g.recipient_type,g.amount_cad,g.purpose,g.state,g.updated_at,
           p.external_reference,p.recorded_at
    FROM grants g
    JOIN payment_intents p ON p.grant_id=g.id AND p.status='recorded'
    WHERE g.foundation_org_id=$1
      AND p.recorded_at >= $2::date
      AND p.recorded_at < ($3::date + interval '1 day')
    ORDER BY p.recorded_at,g.id
    FOR UPDATE OF g
  `, [packageRow.foundation_org_id, packageRow.fiscal_period_start, packageRow.fiscal_period_end]);
  return rows;
}

function assertLedgerMatchesPackage(packagePayload, rows) {
  const ledger = packagePayload?.ledger || {};
  if (Number(ledger.paidGrantCount) !== rows.length) {
    throw new Error('Fiscal package no longer matches the recorded-payment ledger; prepare and file an updated package before closeout.');
  }
  let qd = 0;
  let nqd = 0;
  for (const row of rows) {
    const cents = moneyToCents(row.amount_cad);
    if (row.recipient_type === 'qualified_donee') qd += cents;
    else if (row.recipient_type === 'non_qualified_donee') nqd += cents;
    else throw new Error(`Grant ${row.id} has an unsupported recipient type.`);
  }
  if (moneyToCents(ledger.qualifiedDoneeTotalCad || 0) !== qd || moneyToCents(ledger.nonQualifiedDoneeTotalCad || 0) !== nqd) {
    throw new Error('Fiscal package totals no longer match the recorded-payment ledger; prepare and file an updated package before closeout.');
  }
}

export async function recordFiscalReportingSubmission(repository, actor, {
  packageId,
  externalSubmissionReference,
  submittedAt = null,
  idempotencyKey
}) {
  if (!actor?.id) throw new Error('Authentication is required.');
  if (!idempotencyKey) throw new Error('idempotencyKey is required.');
  const reference = String(externalSubmissionReference || '').trim();
  if (!reference) throw new Error('External CRA/certified-software submission reference is required.');
  if (reference.length > 500) throw new Error('External submission reference is too long.');
  const submittedIso = asIso(submittedAt);

  const packageSnapshot = (await repository.pool.query('SELECT * FROM fiscal_reporting_packages WHERE id=$1', [packageId])).rows[0];
  if (!packageSnapshot) throw new Error('Fiscal reporting package not found.');
  requireOrgPermission(actor, packageSnapshot.foundation_org_id, PERMISSIONS.MARK_REPORTED);
  if (!packageSnapshot.filing_ready) throw new Error('Fiscal reporting package is not filing-ready and cannot be closed out.');

  const currentPreview = await previewFiscalReportingPackage(repository, actor, {
    foundationOrgId: packageSnapshot.foundation_org_id,
    fiscalPeriodStart: String(packageSnapshot.fiscal_period_start).slice(0, 10),
    fiscalPeriodEnd: String(packageSnapshot.fiscal_period_end).slice(0, 10)
  });
  if (currentPreview.packageHash !== packageSnapshot.package_hash) {
    throw new Error('The fiscal reporting package no longer matches the current recorded-payment/reporting metadata. Prepare and file an updated package before closeout.');
  }

  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const replay = (await client.query('SELECT * FROM fiscal_reporting_submissions WHERE idempotency_key=$1 FOR UPDATE', [idempotencyKey])).rows[0];
    if (replay) {
      if (replay.package_id !== packageId || replay.external_submission_reference !== reference) {
        throw new Error('idempotencyKey was already used for a different fiscal filing closeout.');
      }
      await client.query('COMMIT');
      return summarizeSubmission(replay);
    }

    const packageRow = (await client.query('SELECT * FROM fiscal_reporting_packages WHERE id=$1 FOR UPDATE', [packageId])).rows[0];
    if (!packageRow) throw new Error('Fiscal reporting package not found.');
    if (!packageRow.filing_ready) throw new Error('Fiscal reporting package is not filing-ready and cannot be closed out.');
    const existingSubmission = (await client.query('SELECT * FROM fiscal_reporting_submissions WHERE package_id=$1 FOR UPDATE', [packageId])).rows[0];
    if (existingSubmission) {
      if (existingSubmission.external_submission_reference !== reference) {
        throw new Error('This fiscal reporting package is already closed out with a different external submission reference.');
      }
      await client.query('COMMIT');
      return summarizeSubmission(existingSubmission);
    }

    const rows = await currentPeriodRows(client, packageRow);
    assertLedgerMatchesPackage(packageRow.payload, rows);
    for (const row of rows) {
      if (![GRANT_STATES.PAID, GRANT_STATES.REPORTED].includes(row.state)) {
        throw new Error(`Grant ${row.id} is ${row.state}; every grant in the filed package must be paid or already reported before closeout.`);
      }
      if (!String(row.external_reference || '').trim()) throw new Error(`Grant ${row.id} has no recorded external payment reference.`);
    }

    const fiscalYear = fiscalYearFromEnd(String(packageRow.fiscal_period_end).slice(0, 10));
    const fiscalYearGrants = rows.map(row => ({ recipientOrgId: row.recipient_org_id, amountCad: Number(row.amount_cad) }));
    const scoped = scopedActor(actor, packageRow.foundation_org_id);
    const reportedGrantIds = [];

    for (const row of rows) {
      const classification = classifyGrantReporting({
        recipientType: row.recipient_type,
        recipientOrgId: row.recipient_org_id,
        fiscalYearGrants
      });
      const existingRecord = (await client.query('SELECT * FROM reporting_records WHERE grant_id=$1 AND fiscal_year=$2 FOR UPDATE', [row.id, fiscalYear])).rows[0];
      const existingReference = existingRecord?.payload?.submissionReference || null;
      if (existingRecord?.status === 'filed' && existingReference && existingReference !== reference) {
        throw new Error(`Grant ${row.id} is already linked to a different external filing reference.`);
      }
      const reportingPayload = {
        ...(existingRecord?.payload || {}),
        fiscalReportingPackageId: packageRow.id,
        fiscalReportingPackageHash: packageRow.package_hash,
        grantId: row.id,
        foundationOrgId: row.foundation_org_id,
        recipientOrgId: row.recipient_org_id,
        amountCad: Number(row.amount_cad),
        purpose: row.purpose,
        fiscalYear,
        fiscalPeriodStart: String(packageRow.fiscal_period_start).slice(0, 10),
        fiscalPeriodEnd: String(packageRow.fiscal_period_end).slice(0, 10),
        classification,
        externalPaymentReference: row.external_reference,
        submissionReference: reference,
        submissionRecordedAt: submittedIso,
        filingStatus: 'external_submission_reference_recorded'
      };
      const reporting = (await client.query(`
        INSERT INTO reporting_records
          (grant_id,fiscal_year,reporting_route,t3010_version,t1441_required,payload,status)
        VALUES ($1,$2,$3,NULL,$4,$5::jsonb,'filed')
        ON CONFLICT (grant_id,fiscal_year) DO UPDATE SET
          reporting_route=EXCLUDED.reporting_route,
          t1441_required=EXCLUDED.t1441_required,
          payload=EXCLUDED.payload,
          status='filed',
          updated_at=now()
        RETURNING *
      `, [row.id, fiscalYear, classification.route, classification.t1441Required, JSON.stringify(reportingPayload)])).rows[0];

      if (row.state === GRANT_STATES.PAID) {
        const transitionKey = `${idempotencyKey}:grant:${row.id}`;
        const next = transitionGrant(
          { id: row.id, state: row.state, updatedAt: row.updated_at?.toISOString?.() || row.updated_at },
          GRANT_STATES.REPORTED,
          scoped,
          { reportingRecordId: reporting.id, submissionReference: reference, idempotencyKey: transitionKey }
        );
        await client.query('UPDATE grants SET state=$2,updated_at=$3 WHERE id=$1', [row.id, next.state, next.updatedAt]);
        await client.query(`
          INSERT INTO grant_events (grant_id,idempotency_key,from_state,to_state,actor_user_id,metadata,occurred_at)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
        `, [row.id, transitionKey, GRANT_STATES.PAID, GRANT_STATES.REPORTED, actor.id,
          JSON.stringify({ reportingRecordId: reporting.id, fiscalReportingPackageId: packageRow.id, submissionReference: reference }), next.updatedAt]);
      }
      await appendAudit(repository, client, {
        actor,
        organizationId: packageRow.foundation_org_id,
        action: 'reporting.filed_recorded',
        resourceType: 'reporting_record',
        resourceId: reporting.id,
        requestId: `${idempotencyKey}:reporting:${row.id}`,
        payload: { grantId: row.id, fiscalReportingPackageId: packageRow.id, submissionReference: reference }
      });
      reportedGrantIds.push(row.id);
    }

    const submission = (await client.query(`
      INSERT INTO fiscal_reporting_submissions
        (package_id,foundation_org_id,package_hash,external_submission_reference,submitted_at,recorded_by,idempotency_key,grant_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [packageRow.id, packageRow.foundation_org_id, packageRow.package_hash, reference, submittedIso, actor.id, idempotencyKey, rows.length])).rows[0];
    await appendAudit(repository, client, {
      actor,
      organizationId: packageRow.foundation_org_id,
      action: 'fiscal_reporting_submission.recorded',
      resourceType: 'fiscal_reporting_submission',
      resourceId: submission.id,
      requestId: idempotencyKey,
      payload: {
        fiscalReportingPackageId: packageRow.id,
        packageHash: packageRow.package_hash,
        submissionReference: reference,
        submittedAt: submittedIso,
        grantCount: rows.length
      }
    });
    await client.query('COMMIT');
    return { ...summarizeSubmission(submission), reportedGrantIds };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getFiscalReportingSubmission(repository, actor, packageId) {
  const { rows } = await repository.pool.query('SELECT * FROM fiscal_reporting_submissions WHERE package_id=$1', [packageId]);
  const row = rows[0];
  if (!row) return null;
  requireOrgPermission(actor, row.foundation_org_id, PERMISSIONS.EXPORT_REPORTING);
  return summarizeSubmission(row);
}
