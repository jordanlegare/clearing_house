import { PERMISSIONS, ROLES, requireOrgPermission } from '../security/rbac.mjs';

function iso(value) {
  if (!value) return null;
  return value?.toISOString?.() || String(value);
}

function countMap(rows, key = 'status') {
  return Object.fromEntries(rows.map(row => [row[key], Number(row.count)]));
}

function sumCad(rows, key) {
  return Number(rows?.[0]?.[key] || 0);
}

function actorOrgIds(actor) {
  return [...new Set((actor?.memberships || []).map(m => m.organizationId).filter(Boolean))];
}

async function accessibleFoundations(repository, actor, organizationId = null) {
  if (!actor?.id) throw new Error('Authentication is required.');
  const admin = (actor.roles || []).includes(ROLES.SYSTEM_ADMIN);
  if (organizationId && !admin) requireOrgPermission(actor, organizationId, PERMISSIONS.READ_PRIVATE_ORG);
  const ids = organizationId ? [organizationId] : admin ? null : actorOrgIds(actor);
  if (ids && ids.length === 0) return [];
  const params = [];
  let where = "organization_type='foundation'";
  if (ids) {
    params.push(ids);
    where += ` AND id=ANY($${params.length}::uuid[])`;
  }
  const { rows } = await repository.pool.query(`
    SELECT id,business_number,legal_name,province,updated_at
    FROM organizations WHERE ${where} ORDER BY legal_name,id
  `, params);
  if (organizationId && !rows[0]) throw new Error('Requested organization is not an accessible foundation.');
  return rows;
}

async function automationStatus(repository, actor) {
  const admin = (actor.roles || []).includes(ROLES.SYSTEM_ADMIN);
  const [jobs, workers] = await Promise.all([
    repository.pool.query(`
      SELECT name,enabled,next_run_at,locked_until,last_started_at,last_completed_at,last_status,
        ${admin ? 'last_error,' : ''} metadata
      FROM automation_jobs ORDER BY name
    `),
    repository.pool.query(`
      SELECT worker_id,state,heartbeat_at,started_at
      FROM automation_worker_heartbeats
      WHERE heartbeat_at > now() - interval '15 minutes'
      ORDER BY heartbeat_at DESC
    `)
  ]);
  const now = Date.now();
  return {
    activeWorkers: workers.rows.map(row => ({ workerId: row.worker_id, state: row.state, heartbeatAt: iso(row.heartbeat_at), startedAt: iso(row.started_at) })),
    jobs: jobs.rows.map(row => ({
      name: row.name,
      enabled: row.enabled,
      status: row.last_status || 'never_run',
      nextRunAt: iso(row.next_run_at),
      lockedUntil: iso(row.locked_until),
      lastStartedAt: iso(row.last_started_at),
      lastCompletedAt: iso(row.last_completed_at),
      ...(admin ? { lastError: row.last_error } : {}),
      overdue: Boolean(row.enabled && row.next_run_at && new Date(row.next_run_at).getTime() < now && (!row.locked_until || new Date(row.locked_until).getTime() < now))
    }))
  };
}

async function foundationStatus(repository, foundation) {
  const id = foundation.id;
  const [
    grantStates, grantMoney, policies, reviewBundles, offerBatches, contacts, discovery,
    pendingChallenges, complianceQueue, paymentIntents, reportingQueue, recentFailures
  ] = await Promise.all([
    repository.pool.query(`SELECT state,count(*)::int AS count FROM grants WHERE foundation_org_id=$1 GROUP BY state ORDER BY state`, [id]),
    repository.pool.query(`
      SELECT COALESCE(sum(amount_cad) FILTER (WHERE state NOT IN ('declined')),0) AS active_cad,
             COALESCE(sum(amount_cad) FILTER (WHERE state='paid'),0) AS paid_cad,
             COALESCE(sum(amount_cad) FILTER (WHERE state='reported'),0) AS reported_cad
      FROM grants WHERE foundation_org_id=$1
    `, [id]),
    repository.pool.query(`
      SELECT enabled,count(*)::int AS count,
        COALESCE(sum(target_budget_cad),0) AS target_cad,
        count(*) FILTER (WHERE enabled AND next_run_at < now())::int AS due
      FROM foundation_allocation_policies WHERE foundation_org_id=$1 GROUP BY enabled ORDER BY enabled DESC
    `, [id]),
    repository.pool.query(`SELECT status,count(*)::int AS count,COALESCE(sum(total_cad),0) AS total_cad FROM grant_review_bundles WHERE foundation_org_id=$1 GROUP BY status ORDER BY status`, [id]),
    repository.pool.query(`SELECT status,count(*)::int AS count FROM grant_offer_batches WHERE foundation_org_id=$1 GROUP BY status ORDER BY status`, [id]),
    repository.pool.query(`
      SELECT c.status,c.source,count(DISTINCT c.id)::int AS count
      FROM recipient_contacts c
      JOIN grants g ON g.recipient_org_id=c.organization_id
      WHERE g.foundation_org_id=$1
      GROUP BY c.status,c.source ORDER BY c.status,c.source
    `, [id]),
    repository.pool.query(`
      SELECT d.status,count(DISTINCT d.organization_id)::int AS count
      FROM recipient_contact_discovery d
      JOIN grants g ON g.recipient_org_id=d.organization_id
      WHERE g.foundation_org_id=$1 GROUP BY d.status ORDER BY d.status
    `, [id]),
    repository.pool.query(`
      SELECT count(DISTINCT ch.id)::int AS count
      FROM recipient_contact_challenges ch
      JOIN recipient_contacts c ON c.id=ch.contact_id
      JOIN grants g ON g.recipient_org_id=c.organization_id
      WHERE g.foundation_org_id=$1 AND ch.used_at IS NULL AND ch.revoked_at IS NULL AND ch.expires_at > now()
    `, [id]),
    repository.pool.query(`
      SELECT
        count(*) FILTER (WHERE g.state='accepted' AND COALESCE(cr.decision,'pending') <> 'approved')::int AS accepted_pending_compliance,
        count(*) FILTER (WHERE g.state='accepted' AND COALESCE(cr.decision,'pending')='approved' AND (rs.id IS NULL OR rs.expires_at <= now() OR rs.status <> 'registered'))::int AS approved_compliance_pending_status
      FROM grants g
      LEFT JOIN LATERAL (SELECT decision FROM compliance_reviews WHERE grant_id=g.id ORDER BY created_at DESC LIMIT 1) cr ON true
      LEFT JOIN LATERAL (SELECT id,status,expires_at FROM recipient_status_checks WHERE organization_id=g.recipient_org_id AND assurance_level='authoritative' ORDER BY verified_at DESC LIMIT 1) rs ON true
      WHERE g.foundation_org_id=$1
    `, [id]),
    repository.pool.query(`
      SELECT p.status,count(*)::int AS count,COALESCE(sum(p.amount_cad),0) AS total_cad
      FROM payment_intents p JOIN grants g ON g.id=p.grant_id
      WHERE g.foundation_org_id=$1 GROUP BY p.status ORDER BY p.status
    `, [id]),
    repository.pool.query(`
      SELECT
        count(*) FILTER (WHERE state='paid')::int AS paid_pending_reporting,
        count(*) FILTER (WHERE state='reported')::int AS reported
      FROM grants WHERE foundation_org_id=$1
    `, [id]),
    repository.pool.query(`
      SELECT 'allocation_policy' AS kind,id::text AS resource_id,last_run_at AS occurred_at,last_result::text AS detail
      FROM foundation_allocation_policies WHERE foundation_org_id=$1 AND last_run_status='failed'
      UNION ALL
      SELECT 'offer_batch_item',i.grant_id::text,i.updated_at,COALESCE(i.last_error,'')
      FROM grant_offer_batch_items i JOIN grant_offer_batches b ON b.id=i.batch_id
      WHERE b.foundation_org_id=$1 AND i.status='failed'
      ORDER BY occurred_at DESC NULLS LAST LIMIT 20
    `, [id])
  ]);

  const enabledPolicy = policies.rows.find(row => row.enabled === true);
  const disabledPolicy = policies.rows.find(row => row.enabled === false);
  return {
    foundation: {
      id,
      businessNumber: foundation.business_number,
      name: foundation.legal_name,
      province: foundation.province
    },
    grants: {
      byState: countMap(grantStates.rows, 'state'),
      activeCad: sumCad(grantMoney.rows, 'active_cad'),
      paidCad: sumCad(grantMoney.rows, 'paid_cad'),
      reportedCad: sumCad(grantMoney.rows, 'reported_cad')
    },
    allocationPolicies: {
      enabled: Number(enabledPolicy?.count || 0),
      disabled: Number(disabledPolicy?.count || 0),
      targetCad: Number(enabledPolicy?.target_cad || 0),
      due: Number(enabledPolicy?.due || 0)
    },
    reviewBundles: Object.fromEntries(reviewBundles.rows.map(row => [row.status, { count: Number(row.count), totalCad: Number(row.total_cad) }])),
    offerBatches: countMap(offerBatches.rows),
    recipientContacts: contacts.rows.map(row => ({ status: row.status, source: row.source, count: Number(row.count) })),
    websiteDiscovery: countMap(discovery.rows),
    pendingContactChallenges: Number(pendingChallenges.rows[0]?.count || 0),
    compliance: {
      acceptedPendingCompliance: Number(complianceQueue.rows[0]?.accepted_pending_compliance || 0),
      approvedCompliancePendingFreshStatus: Number(complianceQueue.rows[0]?.approved_compliance_pending_status || 0)
    },
    payments: Object.fromEntries(paymentIntents.rows.map(row => [row.status, { count: Number(row.count), totalCad: Number(row.total_cad) }])),
    reporting: {
      paidPendingReporting: Number(reportingQueue.rows[0]?.paid_pending_reporting || 0),
      reported: Number(reportingQueue.rows[0]?.reported || 0)
    },
    recentFailures: recentFailures.rows.map(row => ({ kind: row.kind, resourceId: row.resource_id, occurredAt: iso(row.occurred_at), detail: row.detail }))
  };
}

function attentionItems(system, foundations, dataStatus) {
  const items = [];
  if (!dataStatus?.loaded) items.push({ severity: 'critical', scope: 'system', code: 't3010_not_loaded', message: 'T3010 public data is not loaded.' });
  for (const job of system.jobs) {
    if (job.enabled && job.status === 'failed') items.push({ severity: 'high', scope: 'system', code: 'automation_job_failed', message: `${job.name} last failed.`, job: job.name });
    if (job.overdue) items.push({ severity: 'high', scope: 'system', code: 'automation_job_overdue', message: `${job.name} is overdue and not actively leased.`, job: job.name });
  }
  if (system.jobs.some(job => job.enabled) && system.activeWorkers.length === 0) items.push({ severity: 'critical', scope: 'system', code: 'no_active_worker', message: 'Automation jobs are enabled but no worker heartbeat is current.' });
  for (const status of foundations) {
    const name = status.foundation.name;
    if ((status.reviewBundles.open?.count || 0) > 0 || (status.reviewBundles.partial?.count || 0) > 0) items.push({ severity: 'medium', scope: status.foundation.id, code: 'review_bundles_waiting', message: `${name} has review bundles awaiting approval.` });
    if ((status.offerBatches.pending_contacts || 0) > 0) items.push({ severity: 'medium', scope: status.foundation.id, code: 'recipient_contacts_pending', message: `${name} has approved offers waiting for recipient contact verification.` });
    if (status.compliance.acceptedPendingCompliance > 0) items.push({ severity: 'high', scope: status.foundation.id, code: 'compliance_waiting', message: `${name} has accepted grants waiting for compliance review.` });
    if (status.compliance.approvedCompliancePendingFreshStatus > 0) items.push({ severity: 'high', scope: status.foundation.id, code: 'cra_status_waiting', message: `${name} has compliance-approved accepted grants without fresh registered-status evidence.` });
    if (status.reporting.paidPendingReporting > 0) items.push({ severity: 'medium', scope: status.foundation.id, code: 'reporting_waiting', message: `${name} has paid grants not yet marked reported.` });
    if (status.recentFailures.length) items.push({ severity: 'high', scope: status.foundation.id, code: 'workflow_failures', message: `${name} has recent allocation/offer failures requiring review.` });
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return items.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
}

export async function buildOperationalStatus({ repository, t3010Repository, actor, organizationId = null }) {
  if (!repository?.pool) throw new Error('Operational status requires PostgreSQL persistence.');
  const foundations = await accessibleFoundations(repository, actor, organizationId);
  const [system, foundationStatuses] = await Promise.all([
    automationStatus(repository, actor),
    Promise.all(foundations.map(foundation => foundationStatus(repository, foundation)))
  ]);
  const data = t3010Repository?.status?.() || { loaded: false };
  const attention = attentionItems(system, foundationStatuses, data);
  return {
    generatedAt: new Date().toISOString(),
    data,
    system,
    foundations: foundationStatuses,
    attention,
    summary: {
      foundations: foundationStatuses.length,
      attentionItems: attention.length,
      critical: attention.filter(item => item.severity === 'critical').length,
      high: attention.filter(item => item.severity === 'high').length,
      medium: attention.filter(item => item.severity === 'medium').length
    }
  };
}
