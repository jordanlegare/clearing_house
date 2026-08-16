import { PERMISSIONS, requireOrgPermission } from '../security/rbac.mjs';
import { buildAuditEntry } from '../security/audit.mjs';
import { moneyToCents } from '../matching/portfolio.mjs';
import { createAllocationPolicy } from '../automation/allocation_policies.mjs';
import { deriveSchedule8Evidence, chooseDqBasis, reconcileEnvelope, dqSuggestionHash } from '../domain/dq_evidence.mjs';

function cad(cents) { return cents / 100; }
function dateOnly(value, name) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new Error(`${name} must be YYYY-MM-DD.`);
  return text;
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
  await client.query(`INSERT INTO audit_log
    (occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,request_id,payload_digest,previous_digest,entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [occurredAt, actor?.id || null, organizationId || null, action, resourceType, String(resourceId), requestId || null, entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

async function planningCommitments(repository, foundationOrgId, targetFiscalYear, windowStart, windowEnd) {
  const executed = Number((await repository.pool.query(`
    SELECT COALESCE(SUM(g.amount_cad),0) AS total
    FROM grants g
    JOIN payment_intents p ON p.grant_id=g.id
    WHERE g.foundation_org_id=$1
      AND p.status='recorded'
      AND p.recorded_at >= $2::date
      AND p.recorded_at < ($3::date + interval '1 day')
  `, [foundationOrgId, windowStart, windowEnd])).rows[0].total);

  const activeStates = ['draft','proposed','approved','offered','accepted','payment_authorized'];
  const pipeline = Number((await repository.pool.query(`
    SELECT COALESCE(SUM(amount_cad),0) AS total
    FROM grants
    WHERE foundation_org_id=$1 AND planning_fiscal_year=$2 AND state=ANY($3::text[])
  `, [foundationOrgId, targetFiscalYear, activeStates])).rows[0].total);

  const unattributed = Number((await repository.pool.query(`
    SELECT COALESCE(SUM(amount_cad),0) AS total
    FROM grants
    WHERE foundation_org_id=$1 AND planning_fiscal_year IS NULL AND state=ANY($2::text[])
  `, [foundationOrgId, activeStates])).rows[0].total);

  const policies = (await repository.pool.query(`
    SELECT p.id,p.target_budget_cad,
      COALESCE(SUM(g.amount_cad) FILTER (WHERE g.state NOT IN ('declined','cancelled')),0) AS linked_cad
    FROM foundation_allocation_policies p
    LEFT JOIN grants g ON g.automation_policy_id=p.id
    WHERE p.foundation_org_id=$1
      AND p.enabled=true
      AND EXTRACT(YEAR FROM p.window_end)::integer=$2
    GROUP BY p.id,p.target_budget_cad
  `, [foundationOrgId, targetFiscalYear])).rows;
  const policyUnfilled = policies.reduce((sum, row) => {
    const target = moneyToCents(Number(row.target_budget_cad), 'policy target');
    const linked = moneyToCents(Number(row.linked_cad), 'policy linked grants');
    return sum + Math.max(0, target - linked);
  }, 0);

  return {
    executedGrantCad: executed,
    activePipelineCad: pipeline,
    unattributedPipelineCad: unattributed,
    existingPolicyUnfilledCad: cad(policyUnfilled),
    existingPolicyCount: policies.length
  };
}

export async function suggestDqAllocationEnvelope(service, actor, {
  foundationOrgId,
  targetFiscalYear,
  windowStart,
  windowEnd,
  mode = 'auto',
  eligiblePropertyCad = null,
  flatRate = 0.05,
  otherExpectedQualifyingDisbursementsCad = 0,
  includeUnattributedPipeline = true
}) {
  requireOrgPermission(actor, foundationOrgId, PERMISSIONS.READ_PRIVATE_ORG);
  if (!service.t3010Repository?.loaded) throw new Error('T3010 repository must be loaded to derive DQ evidence.');
  const start = dateOnly(windowStart, 'windowStart');
  const end = dateOnly(windowEnd, 'windowEnd');
  if (end < start) throw new Error('windowEnd must be on or after windowStart.');
  const year = Number(targetFiscalYear);
  if (Number(end.slice(0,4)) !== year) throw new Error('windowEnd year must match targetFiscalYear.');

  const organization = await service.repository.getOrganization(foundationOrgId);
  if (!organization || organization.organization_type !== 'foundation') throw new Error('Foundation organization not found.');
  const foundationBn = String(organization.business_number || '').toUpperCase().replace(/[\s-]/g, '');
  const profile = service.t3010Repository.foundationProfile(foundationBn);
  if (!profile) throw new Error('Foundation is not present in the loaded T3010 foundation dataset.');
  const evidence = deriveSchedule8Evidence(profile);
  const basis = chooseDqBasis({ evidence, targetFiscalYear: year, mode, eligiblePropertyCad, flatRate });
  const commitments = await planningCommitments(service.repository, foundationOrgId, year, start, end);
  const reconciled = reconcileEnvelope({
    grossDqCad: basis.grossDqCad,
    ...commitments,
    otherExpectedQualifyingDisbursementsCad,
    includeUnattributedPipeline
  });

  const snapshot = {
    foundationOrgId,
    foundationBn,
    foundationName: organization.legal_name,
    targetFiscalYear: year,
    windowStart: start,
    windowEnd: end,
    budgetBasis: basis.budgetBasis,
    grossDqCad: reconciled.grossModeledDqCad,
    eligiblePropertyCad: basis.eligiblePropertyCad ?? null,
    flatRate: basis.flatRate ?? null,
    basisSource: basis.source,
    sourceYear: basis.sourceYear ?? evidence.sourceYear,
    schedule8Evidence: evidence,
    executedGrantCad: reconciled.executedGrantCad,
    activePipelineCad: reconciled.activePipelineCad,
    unattributedPipelineCad: reconciled.unattributedPipelineCad,
    existingPolicyUnfilledCad: reconciled.existingPolicyUnfilledCad,
    existingPolicyCount: commitments.existingPolicyCount,
    otherExpectedQualifyingDisbursementsCad: reconciled.otherExpectedQualifyingDisbursementsCad,
    includeUnattributedPipeline: reconciled.includeUnattributedPipeline,
    totalReservedOrExecutedCad: reconciled.totalReservedOrExecutedCad,
    suggestedUnreservedEnvelopeCad: reconciled.suggestedUnreservedEnvelopeCad,
    overReservedCad: reconciled.overReservedCad,
    caveats: [
      'This is a grant-planning envelope, not a CRA filing calculation or legal determination.',
      'Annual T3010 data is historical filing evidence; explicit eligible-property inputs are assumptions supplied by the foundation when public filing vintage is stale.',
      'Own charitable activities and other qualifying disbursements are subtracted only through otherExpectedQualifyingDisbursementsCad unless already represented as executed grants in this system.',
      'Unattributed active grants are conservatively reserved by default because they do not yet carry a fiscal-year planning tag.'
    ]
  };
  snapshot.suggestionHash = dqSuggestionHash(snapshot);
  return snapshot;
}

export async function createDqBackedAllocationPolicy(service, actor, args) {
  requireOrgPermission(actor, args.foundationOrgId, PERMISSIONS.PROPOSE_GRANT);
  const suggestion = await suggestDqAllocationEnvelope(service, actor, args);
  if (suggestion.suggestionHash !== args.suggestionHash) throw new Error('DQ envelope suggestion has changed. Rebuild and review the current suggestion before creating a policy.');
  const requestedCents = args.targetBudgetCad == null
    ? moneyToCents(suggestion.suggestedUnreservedEnvelopeCad, 'suggestedUnreservedEnvelopeCad')
    : moneyToCents(args.targetBudgetCad, 'targetBudgetCad');
  const availableCents = moneyToCents(suggestion.suggestedUnreservedEnvelopeCad, 'suggestedUnreservedEnvelopeCad');
  if (requestedCents <= 0) throw new Error('No positive unreserved DQ planning capacity is available for a new allocation policy.');
  if (requestedCents > availableCents) throw new Error('Requested policy budget exceeds the current unreserved DQ planning envelope.');

  const policy = await createAllocationPolicy(service.repository, actor, {
    foundationOrgId: args.foundationOrgId,
    title: args.title,
    targetBudgetCad: cad(requestedCents),
    focus: args.focus || '',
    province: args.province || '',
    minGrantCad: args.minGrantCad ?? 25_000,
    maxGrantCad: args.maxGrantCad ?? 250_000,
    maxRecipients: args.maxRecipients ?? 100,
    minimumScore: args.minimumScore ?? 0,
    purpose: args.purpose || 'General operating support',
    windowStart: args.windowStart,
    windowEnd: args.windowEnd,
    refreshIntervalSeconds: args.refreshIntervalSeconds ?? 3600,
    autoMaterializeDrafts: args.autoMaterializeDrafts !== false,
    idempotencyKey: args.idempotencyKey
  });

  const client = await service.repository.pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT budget_basis,budget_basis_hash FROM foundation_allocation_policies WHERE id=$1 FOR UPDATE', [policy.id])).rows[0];
    if (current.budget_basis_hash && current.budget_basis_hash !== suggestion.suggestionHash) {
      throw new Error('This idempotency key already created a policy from a different DQ envelope snapshot.');
    }
    await client.query(`
      UPDATE foundation_allocation_policies
      SET budget_basis=$2,budget_basis_snapshot=$3::jsonb,budget_basis_hash=$4,updated_at=now()
      WHERE id=$1
    `, [policy.id, suggestion.budgetBasis, JSON.stringify(suggestion), suggestion.suggestionHash]);
    await appendAudit(service.repository, client, {
      actor,
      organizationId: args.foundationOrgId,
      action: 'allocation_policy.dq_basis_attached',
      resourceType: 'allocation_policy',
      resourceId: policy.id,
      requestId: args.idempotencyKey,
      payload: { suggestionHash: suggestion.suggestionHash, budgetBasis: suggestion.budgetBasis, targetBudgetCad: cad(requestedCents), targetFiscalYear: suggestion.targetFiscalYear }
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return { ...policy, budgetBasis: suggestion.budgetBasis, budgetBasisHash: suggestion.suggestionHash, budgetBasisSnapshot: suggestion };
}

export async function getDqPolicyBasis(service, actor, { policyId }) {
  const row = (await service.repository.pool.query('SELECT * FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!row) throw new Error('Allocation policy not found.');
  requireOrgPermission(actor, row.foundation_org_id, PERMISSIONS.READ_PRIVATE_ORG);
  return {
    policyId: row.id,
    foundationOrgId: row.foundation_org_id,
    targetBudgetCad: Number(row.target_budget_cad),
    budgetBasis: row.budget_basis,
    budgetBasisHash: row.budget_basis_hash,
    budgetBasisSnapshot: row.budget_basis_snapshot,
    planningFiscalYear: Number(String(row.window_end).slice(0,4)) || null,
    version: row.version
  };
}
