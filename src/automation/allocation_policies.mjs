import crypto from 'node:crypto';
import { buildAuditEntry } from '../security/audit.mjs';
import { PERMISSIONS, ROLES, requireOrgPermission } from '../security/rbac.mjs';
import { moneyToCents } from '../matching/portfolio.mjs';
import { T3010Repository } from '../t3010/repository.mjs';
import { WorkflowService } from '../workflow/workflow_service.mjs';
import { buildFoundationPortfolio, materializePortfolioDrafts } from '../workflow/portfolio_workflow.mjs';

function cad(cents) { return cents / 100; }
function normalizeProvince(value) { return String(value || '').trim().toUpperCase().slice(0, 3); }
function isoDate(value, name) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) throw new Error(`${name} must be YYYY-MM-DD.`);
  return text;
}

function policyFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    foundationOrgId: row.foundation_org_id,
    title: row.title,
    enabled: row.enabled,
    targetBudgetCad: Number(row.target_budget_cad),
    focus: row.focus,
    province: row.province,
    minGrantCad: Number(row.min_grant_cad),
    maxGrantCad: Number(row.max_grant_cad),
    maxRecipients: row.max_recipients,
    minimumScore: Number(row.minimum_score),
    purpose: row.purpose,
    windowStart: String(row.window_start),
    windowEnd: String(row.window_end),
    refreshIntervalSeconds: row.refresh_interval_seconds,
    autoMaterializeDrafts: row.auto_materialize_drafts,
    version: row.version,
    nextRunAt: row.next_run_at?.toISOString?.() || row.next_run_at,
    lastRunAt: row.last_run_at?.toISOString?.() || row.last_run_at || null,
    lastRunStatus: row.last_run_status || null,
    lastPlanHash: row.last_plan_hash || null,
    lastResult: row.last_result || {},
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at
  };
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
    organizationId: organizationId || '',
    action,
    resourceType,
    resourceId: String(resourceId),
    requestId: requestId || '',
    payload
  });
  await client.query(`
    INSERT INTO audit_log
      (occurred_at, actor_user_id, organization_id, action, resource_type, resource_id, request_id, payload_digest, previous_digest, entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [occurredAt, actor?.id || null, organizationId || null, action, resourceType, String(resourceId), requestId || null, entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

export function computePolicyCapacity({ targetBudgetCad, activeAmountsCad = [], activeRecipientCount = 0, maxRecipients, minGrantCad }) {
  const targetCents = moneyToCents(targetBudgetCad, 'targetBudgetCad');
  const activeCents = activeAmountsCad.reduce((sum, value) => sum + moneyToCents(value, 'active grant amount'), 0);
  const remainingCents = Math.max(0, targetCents - activeCents);
  const slotsRemaining = Math.max(0, Number(maxRecipients) - Number(activeRecipientCount));
  const minGrantCents = moneyToCents(minGrantCad, 'minGrantCad');
  return {
    targetCad: cad(targetCents),
    activeCad: cad(activeCents),
    remainingCad: cad(remainingCents),
    slotsRemaining,
    canCreateDrafts: remainingCents >= minGrantCents && slotsRemaining > 0
  };
}

export async function createAllocationPolicy(repository, actor, args) {
  requireOrgPermission(actor, args.foundationOrgId, PERMISSIONS.PROPOSE_GRANT);
  const targetCents = moneyToCents(args.targetBudgetCad, 'targetBudgetCad');
  const minCents = moneyToCents(args.minGrantCad ?? 25_000, 'minGrantCad');
  const maxCents = moneyToCents(args.maxGrantCad ?? 250_000, 'maxGrantCad');
  if (targetCents <= 0 || minCents <= 0 || maxCents < minCents) throw new Error('Allocation policy monetary bounds are invalid.');
  const windowStart = isoDate(args.windowStart, 'windowStart');
  const windowEnd = isoDate(args.windowEnd, 'windowEnd');
  if (windowEnd < windowStart) throw new Error('windowEnd must be on or after windowStart.');
  const maxRecipients = Number(args.maxRecipients ?? 100);
  if (!Number.isInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 500) throw new Error('maxRecipients must be between 1 and 500.');
  const minimumScore = Number(args.minimumScore ?? 0);
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) throw new Error('minimumScore must be between 0 and 1.');
  const refresh = Number(args.refreshIntervalSeconds ?? 3600);
  if (!Number.isInteger(refresh) || refresh < 300 || refresh > 604800) throw new Error('refreshIntervalSeconds must be between 300 and 604800.');
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const foundation = (await client.query("SELECT id FROM organizations WHERE id=$1 AND organization_type='foundation'", [args.foundationOrgId])).rows[0];
    if (!foundation) throw new Error('Foundation organization not found.');
    const row = (await client.query(`
      INSERT INTO foundation_allocation_policies
        (foundation_org_id,title,target_budget_cad,focus,province,min_grant_cad,max_grant_cad,max_recipients,
         minimum_score,purpose,window_start,window_end,refresh_interval_seconds,auto_materialize_drafts,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
      RETURNING *
    `, [args.foundationOrgId, String(args.title).trim(), cad(targetCents), String(args.focus || '').trim(), normalizeProvince(args.province), cad(minCents), cad(maxCents), maxRecipients,
      minimumScore, String(args.purpose || 'General operating support').trim(), windowStart, windowEnd, refresh, args.autoMaterializeDrafts !== false, actor.id])).rows[0];
    await appendAudit(repository, client, {
      actor, organizationId: args.foundationOrgId, action: 'allocation_policy.created', resourceType: 'allocation_policy', resourceId: row.id,
      requestId: args.idempotencyKey, payload: { title: row.title, targetBudgetCad: Number(row.target_budget_cad), windowStart, windowEnd, autoMaterializeDrafts: row.auto_materialize_drafts }
    });
    await client.query('COMMIT');
    return policyFromRow(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function listAllocationPolicies(repository, actor, { foundationOrgId = null } = {}) {
  if (!actor?.id) throw new Error('Authentication is required.');
  let organizationIds = [];
  const systemAdmin = (actor.roles || []).includes(ROLES.SYSTEM_ADMIN);
  if (foundationOrgId) {
    requireOrgPermission(actor, foundationOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    organizationIds = [foundationOrgId];
  } else if (!systemAdmin) {
    organizationIds = [...new Set((actor.memberships || []).map(m => m.organizationId).filter(Boolean))];
    if (!organizationIds.length) return [];
  }
  const query = systemAdmin && !foundationOrgId
    ? ['SELECT * FROM foundation_allocation_policies ORDER BY updated_at DESC', []]
    : ['SELECT * FROM foundation_allocation_policies WHERE foundation_org_id = ANY($1::uuid[]) ORDER BY updated_at DESC', [organizationIds]];
  const { rows } = await repository.pool.query(query[0], query[1]);
  return rows.map(policyFromRow);
}

export async function updateAllocationPolicy(repository, actor, { policyId, patch = {}, idempotencyKey }) {
  const current = (await repository.pool.query('SELECT * FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!current) throw new Error('Allocation policy not found.');
  requireOrgPermission(actor, current.foundation_org_id, PERMISSIONS.PROPOSE_GRANT);
  const next = {
    title: patch.title ?? current.title,
    targetBudgetCad: patch.targetBudgetCad ?? Number(current.target_budget_cad),
    focus: patch.focus ?? current.focus,
    province: patch.province ?? current.province,
    minGrantCad: patch.minGrantCad ?? Number(current.min_grant_cad),
    maxGrantCad: patch.maxGrantCad ?? Number(current.max_grant_cad),
    maxRecipients: patch.maxRecipients ?? current.max_recipients,
    minimumScore: patch.minimumScore ?? Number(current.minimum_score),
    purpose: patch.purpose ?? current.purpose,
    windowStart: patch.windowStart ?? String(current.window_start),
    windowEnd: patch.windowEnd ?? String(current.window_end),
    refreshIntervalSeconds: patch.refreshIntervalSeconds ?? current.refresh_interval_seconds,
    autoMaterializeDrafts: patch.autoMaterializeDrafts ?? current.auto_materialize_drafts
  };
  const targetCents = moneyToCents(next.targetBudgetCad, 'targetBudgetCad');
  const minCents = moneyToCents(next.minGrantCad, 'minGrantCad');
  const maxCents = moneyToCents(next.maxGrantCad, 'maxGrantCad');
  if (targetCents <= 0 || minCents <= 0 || maxCents < minCents) throw new Error('Allocation policy monetary bounds are invalid.');
  if (!Number.isInteger(Number(next.maxRecipients)) || next.maxRecipients < 1 || next.maxRecipients > 500) throw new Error('maxRecipients must be between 1 and 500.');
  if (!Number.isFinite(Number(next.minimumScore)) || next.minimumScore < 0 || next.minimumScore > 1) throw new Error('minimumScore must be between 0 and 1.');
  if (!Number.isInteger(Number(next.refreshIntervalSeconds)) || next.refreshIntervalSeconds < 300 || next.refreshIntervalSeconds > 604800) throw new Error('refreshIntervalSeconds must be between 300 and 604800.');
  const windowStart = isoDate(next.windowStart, 'windowStart');
  const windowEnd = isoDate(next.windowEnd, 'windowEnd');
  if (windowEnd < windowStart) throw new Error('windowEnd must be on or after windowStart.');

  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`
      UPDATE foundation_allocation_policies SET
        title=$2,target_budget_cad=$3,focus=$4,province=$5,min_grant_cad=$6,max_grant_cad=$7,max_recipients=$8,
        minimum_score=$9,purpose=$10,window_start=$11,window_end=$12,refresh_interval_seconds=$13,auto_materialize_drafts=$14,
        version=version+1,next_run_at=now(),updated_by=$15,updated_at=now()
      WHERE id=$1 RETURNING *
    `, [policyId, String(next.title).trim(), cad(targetCents), String(next.focus || '').trim(), normalizeProvince(next.province), cad(minCents), cad(maxCents), Number(next.maxRecipients),
      Number(next.minimumScore), String(next.purpose).trim(), windowStart, windowEnd, Number(next.refreshIntervalSeconds), Boolean(next.autoMaterializeDrafts), actor.id])).rows[0];
    await appendAudit(repository, client, {
      actor, organizationId: current.foundation_org_id, action: 'allocation_policy.updated', resourceType: 'allocation_policy', resourceId: policyId,
      requestId: idempotencyKey, payload: { version: row.version, targetBudgetCad: Number(row.target_budget_cad), windowStart, windowEnd }
    });
    await client.query('COMMIT');
    return policyFromRow(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function setAllocationPolicyEnabled(repository, actor, { policyId, enabled, idempotencyKey }) {
  const current = (await repository.pool.query('SELECT * FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!current) throw new Error('Allocation policy not found.');
  requireOrgPermission(actor, current.foundation_org_id, PERMISSIONS.PROPOSE_GRANT);
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`
      UPDATE foundation_allocation_policies SET enabled=$2,next_run_at=CASE WHEN $2 THEN now() ELSE next_run_at END,
        updated_by=$3,updated_at=now() WHERE id=$1 RETURNING *
    `, [policyId, Boolean(enabled), actor.id])).rows[0];
    await appendAudit(repository, client, {
      actor, organizationId: current.foundation_org_id, action: enabled ? 'allocation_policy.resumed' : 'allocation_policy.paused',
      resourceType: 'allocation_policy', resourceId: policyId, requestId: idempotencyKey, payload: { enabled: Boolean(enabled), version: row.version }
    });
    await client.query('COMMIT');
    return policyFromRow(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function scheduleAllocationPolicyNow(repository, actor, { policyId, idempotencyKey }) {
  const current = (await repository.pool.query('SELECT * FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!current) throw new Error('Allocation policy not found.');
  requireOrgPermission(actor, current.foundation_org_id, PERMISSIONS.PROPOSE_GRANT);
  const row = (await repository.pool.query('UPDATE foundation_allocation_policies SET next_run_at=now(),updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *', [policyId, actor.id])).rows[0];
  return policyFromRow(row);
}

async function actorForUser(repository, userId) {
  const user = (await repository.pool.query('SELECT id,oidc_subject,email,display_name FROM users WHERE id=$1', [userId])).rows[0];
  if (!user) throw new Error('Allocation policy creator user no longer exists.');
  const [global, memberships] = await Promise.all([
    repository.pool.query('SELECT role FROM user_global_roles WHERE user_id=$1', [userId]),
    repository.pool.query('SELECT organization_id,role FROM memberships WHERE user_id=$1', [userId])
  ]);
  return {
    id: user.id, subject: user.oidc_subject, email: user.email, displayName: user.display_name,
    roles: global.rows.map(r => r.role), memberships: memberships.rows.map(r => ({ organizationId: r.organization_id, role: r.role }))
  };
}

async function policyState(repository, policyId) {
  const grants = await repository.pool.query(`
    SELECT g.id,g.amount_cad,g.state,g.recipient_org_id,o.business_number
    FROM grants g JOIN organizations o ON o.id=g.recipient_org_id
    WHERE g.automation_policy_id=$1
    ORDER BY g.created_at
  `, [policyId]);
  const active = grants.rows.filter(row => !['declined','cancelled'].includes(row.state));
  return {
    grants: grants.rows,
    activeAmountsCad: active.map(row => Number(row.amount_cad)),
    activeRecipientCount: new Set(active.map(row => row.recipient_org_id)).size,
    excludedBusinessNumbers: [...new Set(grants.rows.map(row => row.business_number).filter(Boolean))]
  };
}

async function recordPolicyRun(repository, policy, result, status, runId, planHash = null) {
  const nextInterval = Number(policy.refresh_interval_seconds);
  await repository.pool.query(`
    UPDATE foundation_allocation_policy_runs SET status=$2,planned_cad=$3,draft_count=$4,plan_hash=$5,result=$6::jsonb,completed_at=now()
    WHERE id=$1
  `, [runId, status, Number(result?.plannedCad || result?.totalCad || 0), Number(result?.draftCount || 0), planHash, JSON.stringify(result || {})]);
  await repository.pool.query(`
    UPDATE foundation_allocation_policies SET last_run_at=now(),last_run_status=$2,last_plan_hash=$3,last_result=$4::jsonb,
      next_run_at=now() + ($5 * interval '1 second'),updated_at=now()
    WHERE id=$1
  `, [policy.id, status, planHash, JSON.stringify(result || {}), nextInterval]);
}

export async function runOneAllocationPolicy({ config, repository, policyId, t3010Repository }) {
  const policy = (await repository.pool.query('SELECT * FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!policy || !policy.enabled) return { skipped: true, reason: 'policy_disabled_or_missing' };
  const today = new Date().toISOString().slice(0, 10);
  if (today < String(policy.window_start)) {
    await repository.pool.query('UPDATE foundation_allocation_policies SET next_run_at=$2::date, last_run_status=\'skipped\', last_run_at=now(), last_result=$3::jsonb WHERE id=$1', [policy.id, policy.window_start, JSON.stringify({ reason: 'window_not_started' })]);
    return { skipped: true, reason: 'window_not_started' };
  }
  if (today > String(policy.window_end)) {
    await repository.pool.query('UPDATE foundation_allocation_policies SET enabled=false,last_run_status=\'exhausted\',last_run_at=now(),last_result=$2::jsonb,updated_at=now() WHERE id=$1', [policy.id, JSON.stringify({ reason: 'window_closed' })]);
    return { exhausted: true, reason: 'window_closed' };
  }

  const actor = await actorForUser(repository, policy.created_by);
  requireOrgPermission(actor, policy.foundation_org_id, PERMISSIONS.PROPOSE_GRANT);
  const state = await policyState(repository, policy.id);
  const capacity = computePolicyCapacity({
    targetBudgetCad: Number(policy.target_budget_cad),
    activeAmountsCad: state.activeAmountsCad,
    activeRecipientCount: state.activeRecipientCount,
    maxRecipients: policy.max_recipients,
    minGrantCad: Number(policy.min_grant_cad)
  });
  const run = (await repository.pool.query(`
    INSERT INTO foundation_allocation_policy_runs (policy_id,policy_version,remaining_budget_before_cad)
    VALUES ($1,$2,$3) RETURNING id
  `, [policy.id, policy.version, capacity.remainingCad])).rows[0];

  if (!capacity.canCreateDrafts) {
    const result = { ...capacity, reason: capacity.slotsRemaining === 0 ? 'recipient_limit_reached' : 'remaining_budget_below_minimum_grant' };
    await recordPolicyRun(repository, policy, result, 'exhausted', run.id);
    return { exhausted: true, ...result };
  }

  try {
    const service = new WorkflowService({ repository, t3010Repository, config });
    const plan = await buildFoundationPortfolio(service, actor, {
      foundationOrgId: policy.foundation_org_id,
      budgetCad: capacity.remainingCad,
      focus: policy.focus,
      province: policy.province,
      minGrantCad: Number(policy.min_grant_cad),
      maxGrantCad: Number(policy.max_grant_cad),
      maxRecipients: capacity.slotsRemaining,
      minimumScore: Number(policy.minimum_score),
      purpose: policy.purpose,
      excludedBusinessNumbers: state.excludedBusinessNumbers
    });
    if (!plan.allocations.length) {
      const result = { ...capacity, candidateCount: plan.candidateCount, warnings: plan.warnings, reason: 'no_new_matching_recipients' };
      await recordPolicyRun(repository, policy, result, 'exhausted', run.id, plan.planHash);
      return { exhausted: true, ...result };
    }

    if (!policy.auto_materialize_drafts) {
      const result = { ...capacity, plannedCad: plan.allocatedCad, draftCount: 0, allocations: plan.allocations, warnings: plan.warnings, reason: 'planning_only' };
      await recordPolicyRun(repository, policy, result, 'success', run.id, plan.planHash);
      return result;
    }

    const materialized = await materializePortfolioDrafts(service, actor, {
      foundationOrgId: policy.foundation_org_id,
      purpose: policy.purpose,
      allocations: plan.allocations,
      planHash: plan.planHash,
      idempotencyKey: `allocation-policy:${policy.id}:v${policy.version}`
    });
    const grantIds = materialized.drafts.map(entry => entry.grant.id);
    const linked = await repository.pool.query(`
      UPDATE grants SET automation_policy_id=$1
      WHERE id=ANY($2::uuid[]) AND (automation_policy_id IS NULL OR automation_policy_id=$1)
      RETURNING id
    `, [policy.id, grantIds]);
    if (linked.rowCount !== grantIds.length) throw new Error('Allocation-policy linking invariant failed: one or more drafts belong to another automation policy.');

    const result = {
      ...capacity,
      plannedCad: materialized.totalCad,
      draftCount: materialized.draftCount,
      grantIds,
      excludedPriorRecipients: state.excludedBusinessNumbers.length,
      warnings: plan.warnings
    };
    await recordPolicyRun(repository, policy, result, 'success', run.id, plan.planHash);
    return result;
  } catch (error) {
    await repository.pool.query(`UPDATE foundation_allocation_policy_runs SET status='failed',error=$2,completed_at=now() WHERE id=$1`, [run.id, String(error.message).slice(0, 8000)]);
    await repository.pool.query(`UPDATE foundation_allocation_policies SET last_run_at=now(),last_run_status='failed',last_result=$2::jsonb,next_run_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1`, [policy.id, JSON.stringify({ error: error.message })]);
    throw error;
  }
}

export async function runAllocationPoliciesJob({ config, repository, dataDir, t3010Repository = null }) {
  if (!config.automatedPortfoliosEnabled) return { skipped: true, reason: 'automated_portfolios_disabled' };
  let publicData = t3010Repository;
  if (!publicData) {
    publicData = new T3010Repository(dataDir);
    try { await publicData.load(); }
    catch (error) { return { skipped: true, reason: 't3010_not_loaded', error: error.message }; }
  }
  if (!publicData.loaded) return { skipped: true, reason: 't3010_not_loaded' };
  const due = await repository.pool.query(`
    SELECT id FROM foundation_allocation_policies
    WHERE enabled=true AND next_run_at <= now()
    ORDER BY next_run_at,id LIMIT $1
  `, [config.allocationPolicyBatchSize]);
  const results = [];
  for (const row of due.rows) {
    try { results.push({ policyId: row.id, status: 'success', result: await runOneAllocationPolicy({ config, repository, policyId: row.id, t3010Repository: publicData }) }); }
    catch (error) { results.push({ policyId: row.id, status: 'failed', error: error.message }); }
  }
  return { processed: results.length, results };
}
