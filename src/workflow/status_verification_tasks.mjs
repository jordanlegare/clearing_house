import { PERMISSIONS, ROLES, requireOrgPermission } from '../security/rbac.mjs';
import { checkCraPublicEvidenceBulk } from '../status/cra-evidence.mjs';

function actorOrgIds(actor) {
  return [...new Set((actor?.memberships || []).map(m => m.organizationId).filter(Boolean))];
}

function normalizeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    grantId: row.grant_id,
    foundationOrgId: row.foundation_org_id,
    recipientOrgId: row.recipient_org_id,
    businessNumber: row.business_number,
    status: row.status,
    publicEvidence: row.public_evidence || {},
    lastCheckedAt: row.last_checked_at?.toISOString?.() || row.last_checked_at || null,
    nextCheckAt: row.next_check_at?.toISOString?.() || row.next_check_at || null,
    completedAt: row.completed_at?.toISOString?.() || row.completed_at || null,
    completedStatusCheckId: row.completed_status_check_id || null,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at
  };
}

async function candidates(repository, maxAgeHours, limit) {
  const { rows } = await repository.pool.query(`
    SELECT g.id AS grant_id,g.foundation_org_id,g.recipient_org_id,o.business_number
    FROM grants g
    JOIN organizations o ON o.id=g.recipient_org_id
    JOIN LATERAL (
      SELECT decision FROM compliance_reviews cr
      WHERE cr.grant_id=g.id ORDER BY cr.created_at DESC LIMIT 1
    ) cr ON true
    LEFT JOIN LATERAL (
      SELECT status,assurance_level,verified_at FROM recipient_status_checks rs
      WHERE rs.organization_id=g.recipient_org_id
      ORDER BY rs.verified_at DESC LIMIT 1
    ) rs ON true
    WHERE g.state='accepted'
      AND cr.decision='approved'
      AND o.business_number IS NOT NULL
      AND (
        rs.status IS DISTINCT FROM 'eligible'
        OR rs.assurance_level IS DISTINCT FROM 'authoritative'
        OR rs.verified_at IS NULL
        OR rs.verified_at < now() - ($1 * interval '1 hour')
      )
    ORDER BY g.updated_at,g.id
    LIMIT $2
  `, [maxAgeHours, Math.min(Math.max(Number(limit) || 50, 1), 200)]);
  return rows;
}

export async function refreshStatusVerificationTasks({
  config,
  repository,
  t3010Repository = null,
  fetchImpl = fetch,
  limit = 50
}) {
  if (!config.enableWorkflowWrites) return { skipped: true, reason: 'workflow_writes_disabled' };
  const rows = await candidates(repository, config.craStatusMaxAgeHours, limit);
  if (!rows.length) return { processed: 0, manualConfirmationRequired: 0, revocationEvidenceFound: 0 };

  for (const row of rows) {
    await repository.pool.query(`
      INSERT INTO recipient_status_verification_tasks
        (grant_id,foundation_org_id,recipient_org_id,business_number,status,next_check_at)
      VALUES ($1,$2,$3,$4,'pending',now())
      ON CONFLICT (grant_id) DO UPDATE SET
        foundation_org_id=EXCLUDED.foundation_org_id,
        recipient_org_id=EXCLUDED.recipient_org_id,
        business_number=EXCLUDED.business_number,
        status='pending',completed_at=NULL,completed_status_check_id=NULL,updated_at=now()
    `, [row.grant_id, row.foundation_org_id, row.recipient_org_id, row.business_number]);
  }

  let evidence;
  try {
    evidence = await checkCraPublicEvidenceBulk({
      organizations: rows.map(row => ({
        businessNumber: row.business_number,
        t3010Profile: t3010Repository?.loaded ? t3010Repository.charityProfile(row.business_number) : null
      })),
      fetchImpl
    });
  } catch (error) {
    await repository.pool.query(`
      UPDATE recipient_status_verification_tasks
      SET status='pending',next_check_at=now()+interval '1 hour',
          public_evidence=jsonb_build_object('sourceFailure',$1),updated_at=now()
      WHERE grant_id=ANY($2::uuid[])
    `, [String(error.message).slice(0, 1000), rows.map(row => row.grant_id)]);
    throw error;
  }

  let manualConfirmationRequired = 0;
  let revocationEvidenceFound = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const item = evidence[index];
    const status = item.revocationEvidenceFound ? 'revocation_evidence_found' : 'manual_confirmation_required';
    if (item.revocationEvidenceFound) revocationEvidenceFound += 1;
    else manualConfirmationRequired += 1;
    await repository.pool.query(`
      UPDATE recipient_status_verification_tasks SET
        status=$2,public_evidence=$3::jsonb,last_checked_at=now(),
        next_check_at=now()+CASE WHEN $2='revocation_evidence_found' THEN interval '1 hour' ELSE interval '12 hours' END,
        updated_at=now()
      WHERE grant_id=$1
    `, [row.grant_id, status, JSON.stringify(item)]);
  }
  return { processed: rows.length, manualConfirmationRequired, revocationEvidenceFound };
}

export async function listStatusVerificationTasks(repository, actor, { foundationOrgId = null, status = null, limit = 100 } = {}) {
  if (!actor?.id) throw new Error('Authentication is required.');
  const admin = (actor.roles || []).includes(ROLES.SYSTEM_ADMIN);
  let foundationIds = null;
  if (foundationOrgId) {
    if (!admin) requireOrgPermission(actor, foundationOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    foundationIds = [foundationOrgId];
  } else if (!admin) {
    foundationIds = actorOrgIds(actor);
    if (!foundationIds.length) return [];
  }
  const params = [];
  const where = [];
  if (foundationIds) { params.push(foundationIds); where.push(`t.foundation_org_id=ANY($${params.length}::uuid[])`); }
  if (status) { params.push(status); where.push(`t.status=$${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const { rows } = await repository.pool.query(`
    SELECT t.*,f.legal_name AS foundation_name,r.legal_name AS recipient_name,g.amount_cad,g.purpose
    FROM recipient_status_verification_tasks t
    JOIN organizations f ON f.id=t.foundation_org_id
    JOIN organizations r ON r.id=t.recipient_org_id
    JOIN grants g ON g.id=t.grant_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE t.status WHEN 'revocation_evidence_found' THEN 0 WHEN 'manual_confirmation_required' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
             t.updated_at DESC
    LIMIT $${params.length}
  `, params);
  return rows.map(row => ({
    ...normalizeTask(row),
    foundationName: row.foundation_name,
    recipientName: row.recipient_name,
    amountCad: Number(row.amount_cad),
    purpose: row.purpose
  }));
}

export async function getStatusVerificationTask(repository, actor, taskId) {
  const { rows } = await repository.pool.query(`
    SELECT t.*,f.legal_name AS foundation_name,r.legal_name AS recipient_name,g.amount_cad,g.purpose
    FROM recipient_status_verification_tasks t
    JOIN organizations f ON f.id=t.foundation_org_id
    JOIN organizations r ON r.id=t.recipient_org_id
    JOIN grants g ON g.id=t.grant_id WHERE t.id=$1
  `, [taskId]);
  const row = rows[0];
  if (!row) throw new Error('Status verification task not found.');
  if (!(actor.roles || []).includes(ROLES.SYSTEM_ADMIN)) requireOrgPermission(actor, row.foundation_org_id, PERMISSIONS.READ_PRIVATE_ORG);
  return {
    ...normalizeTask(row),
    foundationName: row.foundation_name,
    recipientName: row.recipient_name,
    amountCad: Number(row.amount_cad),
    purpose: row.purpose
  };
}

export async function confirmStatusVerificationTask(service, actor, { taskId, observedStatus, idempotencyKey }) {
  const task = await getStatusVerificationTask(service.repository, actor, taskId);
  requireOrgPermission(actor, task.foundationOrgId, PERMISSIONS.VERIFY_RECIPIENT_STATUS);
  if (task.status === 'completed') return task;
  if (task.status === 'revocation_evidence_found' && String(observedStatus).toLowerCase() === 'registered') {
    throw new Error('Published CRA revocation evidence conflicts with a registered observation. Resolve the discrepancy outside the task before recording a registered status.');
  }
  const statusCheck = await service.recordCraStatusVerification(actor, {
    grantId: task.grantId,
    observedStatus,
    verifiedAt: new Date().toISOString(),
    evidence: {
      statusVerificationTaskId: task.id,
      publicEvidence: task.publicEvidence,
      manualConfirmation: 'Actor confirmed the observed status in the current CRA List of charities.'
    },
    idempotencyKey: `${idempotencyKey}:status`
  });
  const { rows } = await service.repository.pool.query(`
    UPDATE recipient_status_verification_tasks SET
      status='completed',completed_at=now(),completed_status_check_id=$2,updated_at=now()
    WHERE id=$1 RETURNING *
  `, [task.id, statusCheck.id]);
  return normalizeTask(rows[0]);
}
