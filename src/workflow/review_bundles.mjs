import crypto from 'node:crypto';
import { buildAuditEntry } from '../security/audit.mjs';
import { moneyToCents } from '../matching/portfolio.mjs';
import { PERMISSIONS, ROLES, requireOrgPermission } from '../security/rbac.mjs';

function cad(cents) { return cents / 100; }

function bundleHash({ foundationOrgId, policyId, policyVersion, items }) {
  const canonical = {
    foundationOrgId,
    policyId,
    policyVersion: Number(policyVersion),
    items: [...items]
      .map(item => ({
        grantId: item.grantId,
        recipientOrgId: item.recipientOrgId,
        amountCents: moneyToCents(item.amountCad, 'bundle item amountCad')
      }))
      .sort((a, b) => a.grantId.localeCompare(b.grantId))
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export { bundleHash as reviewBundleHash };

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
      (occurred_at,actor_user_id,organization_id,action,resource_type,resource_id,request_id,payload_digest,previous_digest,entry_hmac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [occurredAt, actor?.id || null, organizationId || null, action, resourceType, String(resourceId), requestId || null,
    entry.payloadDigest, entry.previousDigest, entry.entryHmac]);
}

function optionFromRow(row) {
  return {
    policyId: row.policy_id,
    autoProposeDrafts: Boolean(row.auto_propose_drafts),
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at || null
  };
}

export async function getPolicyExecutionOptions(repository, actor, { policyId }) {
  const policy = (await repository.pool.query('SELECT foundation_org_id FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!policy) throw new Error('Allocation policy not found.');
  requireOrgPermission(actor, policy.foundation_org_id, PERMISSIONS.READ_PRIVATE_ORG);
  const row = (await repository.pool.query('SELECT * FROM foundation_allocation_policy_execution_options WHERE policy_id=$1', [policyId])).rows[0];
  return row ? optionFromRow(row) : { policyId, autoProposeDrafts: false, updatedBy: null, updatedAt: null };
}

export async function setPolicyExecutionOptions(repository, actor, { policyId, autoProposeDrafts, idempotencyKey }) {
  if (!idempotencyKey) throw new Error('idempotencyKey is required.');
  const policy = (await repository.pool.query('SELECT foundation_org_id FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!policy) throw new Error('Allocation policy not found.');
  requireOrgPermission(actor, policy.foundation_org_id, PERMISSIONS.PROPOSE_GRANT);
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const replay = (await client.query('SELECT * FROM foundation_allocation_policy_option_commands WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
    if (replay) {
      if (replay.policy_id !== policyId || Boolean(replay.auto_propose_drafts) !== Boolean(autoProposeDrafts)) {
        throw new Error('idempotencyKey was already used for a different allocation-policy execution option.');
      }
      const current = (await client.query('SELECT * FROM foundation_allocation_policy_execution_options WHERE policy_id=$1', [policyId])).rows[0];
      await client.query('COMMIT');
      return optionFromRow(current);
    }
    const row = (await client.query(`
      INSERT INTO foundation_allocation_policy_execution_options (policy_id,auto_propose_drafts,updated_by)
      VALUES ($1,$2,$3)
      ON CONFLICT (policy_id) DO UPDATE SET auto_propose_drafts=EXCLUDED.auto_propose_drafts,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING *
    `, [policyId, Boolean(autoProposeDrafts), actor.id])).rows[0];
    await client.query(`
      INSERT INTO foundation_allocation_policy_option_commands (idempotency_key,policy_id,auto_propose_drafts)
      VALUES ($1,$2,$3)
    `, [idempotencyKey, policyId, Boolean(autoProposeDrafts)]);
    await appendAudit(repository, client, {
      actor,
      organizationId: policy.foundation_org_id,
      action: 'allocation_policy.execution_options_updated',
      resourceType: 'allocation_policy',
      resourceId: policyId,
      requestId: idempotencyKey,
      payload: { autoProposeDrafts: Boolean(autoProposeDrafts) }
    });
    await client.query('COMMIT');
    return optionFromRow(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function loadBundle(repository, bundleId) {
  const bundle = (await repository.pool.query('SELECT * FROM grant_review_bundles WHERE id=$1', [bundleId])).rows[0];
  if (!bundle) return null;
  const { rows } = await repository.pool.query(`
    SELECT i.bundle_id,i.grant_id,i.recipient_org_id,i.amount_cad,i.position,
      g.state,g.foundation_org_id,g.proposed_by,g.approved_by,g.amount_cad AS current_amount_cad,g.recipient_org_id AS current_recipient_org_id,
      o.legal_name AS recipient_name,o.business_number AS recipient_bn
    FROM grant_review_bundle_items i
    JOIN grants g ON g.id=i.grant_id
    JOIN organizations o ON o.id=i.recipient_org_id
    WHERE i.bundle_id=$1 ORDER BY i.position
  `, [bundleId]);
  return {
    id: bundle.id,
    policyId: bundle.policy_id,
    policyRunId: bundle.policy_run_id,
    foundationOrgId: bundle.foundation_org_id,
    policyVersion: bundle.policy_version,
    status: bundle.status,
    bundleHash: bundle.bundle_hash,
    grantCount: bundle.grant_count,
    totalCad: Number(bundle.total_cad),
    createdBy: bundle.created_by,
    approvedBy: bundle.approved_by,
    approvedAt: bundle.approved_at?.toISOString?.() || bundle.approved_at || null,
    createdAt: bundle.created_at?.toISOString?.() || bundle.created_at,
    items: rows.map(row => ({
      grantId: row.grant_id,
      recipientOrgId: row.recipient_org_id,
      recipientName: row.recipient_name,
      recipientBn: row.recipient_bn,
      amountCad: Number(row.amount_cad),
      position: row.position,
      state: row.state,
      proposedBy: row.proposed_by,
      approvedBy: row.approved_by,
      currentAmountCad: Number(row.current_amount_cad),
      currentRecipientOrgId: row.current_recipient_org_id
    }))
  };
}

export async function getReviewBundle(repository, actor, { bundleId }) {
  const bundle = await loadBundle(repository, bundleId);
  if (!bundle) throw new Error('Review bundle not found.');
  requireOrgPermission(actor, bundle.foundationOrgId, PERMISSIONS.READ_PRIVATE_ORG);
  return bundle;
}

export async function listReviewBundles(repository, actor, { foundationOrgId = null, status = null, limit = 50 } = {}) {
  if (!actor?.id) throw new Error('Authentication is required.');
  const systemAdmin = (actor.roles || []).includes(ROLES.SYSTEM_ADMIN);
  let ids = [];
  if (foundationOrgId) {
    requireOrgPermission(actor, foundationOrgId, PERMISSIONS.READ_PRIVATE_ORG);
    ids = [foundationOrgId];
  } else if (!systemAdmin) {
    ids = [...new Set((actor.memberships || []).map(m => m.organizationId).filter(Boolean))];
    if (!ids.length) return [];
  }
  const params = [];
  const where = [];
  if (!(systemAdmin && !foundationOrgId)) { params.push(ids); where.push(`foundation_org_id=ANY($${params.length}::uuid[])`); }
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const { rows } = await repository.pool.query(`
    SELECT * FROM grant_review_bundles ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT $${params.length}
  `, params);
  return rows.map(row => ({
    id: row.id, policyId: row.policy_id, policyRunId: row.policy_run_id, foundationOrgId: row.foundation_org_id,
    policyVersion: row.policy_version, status: row.status, bundleHash: row.bundle_hash, grantCount: row.grant_count,
    totalCad: Number(row.total_cad), createdBy: row.created_by, approvedBy: row.approved_by,
    approvedAt: row.approved_at?.toISOString?.() || row.approved_at || null, createdAt: row.created_at?.toISOString?.() || row.created_at
  }));
}

async function createBundleForUnbundledProposals(repository, actor, policy, policyRunId = null) {
  const client = await repository.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT g.id AS grant_id,g.recipient_org_id,g.amount_cad
      FROM grants g
      LEFT JOIN grant_review_bundle_items i ON i.grant_id=g.id
      WHERE g.automation_policy_id=$1 AND g.state='proposed' AND i.grant_id IS NULL
      ORDER BY g.created_at,g.id
      FOR UPDATE OF g
    `, [policy.id]);
    if (!rows.length) { await client.query('COMMIT'); return null; }
    const items = rows.map(row => ({ grantId: row.grant_id, recipientOrgId: row.recipient_org_id, amountCad: Number(row.amount_cad) }));
    const hash = bundleHash({ foundationOrgId: policy.foundation_org_id, policyId: policy.id, policyVersion: policy.version, items });
    const totalCents = items.reduce((sum, item) => sum + moneyToCents(item.amountCad, 'bundle item amountCad'), 0);
    const bundle = (await client.query(`
      INSERT INTO grant_review_bundles
        (policy_id,policy_run_id,foundation_org_id,policy_version,bundle_hash,grant_count,total_cad,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [policy.id, policyRunId, policy.foundation_org_id, policy.version, hash, items.length, cad(totalCents), actor.id])).rows[0];
    let position = 1;
    for (const item of items) {
      await client.query(`
        INSERT INTO grant_review_bundle_items (bundle_id,grant_id,recipient_org_id,amount_cad,position)
        VALUES ($1,$2,$3,$4,$5)
      `, [bundle.id, item.grantId, item.recipientOrgId, item.amountCad, position++]);
    }
    await appendAudit(repository, client, {
      actor,
      organizationId: policy.foundation_org_id,
      action: 'grant_review_bundle.created',
      resourceType: 'grant_review_bundle',
      resourceId: bundle.id,
      requestId: `review-bundle:${bundle.id}:create`,
      payload: { policyId: policy.id, policyVersion: policy.version, policyRunId, grantCount: items.length, totalCad: cad(totalCents), bundleHash: hash }
    });
    await client.query('COMMIT');
    return loadBundle(repository, bundle.id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function preparePolicyReviewBundle(service, actor, { policyId, policyRunId = null }) {
  const policy = (await service.repository.pool.query('SELECT * FROM foundation_allocation_policies WHERE id=$1', [policyId])).rows[0];
  if (!policy) throw new Error('Allocation policy not found.');
  requireOrgPermission(actor, policy.foundation_org_id, PERMISSIONS.PROPOSE_GRANT);
  const option = (await service.repository.pool.query('SELECT * FROM foundation_allocation_policy_execution_options WHERE policy_id=$1', [policyId])).rows[0];
  if (!option?.auto_propose_drafts) return null;

  const drafts = (await service.repository.pool.query(`
    SELECT id FROM grants WHERE automation_policy_id=$1 AND state='draft' ORDER BY created_at,id
  `, [policyId])).rows;
  for (const draft of drafts) {
    await service.proposeGrant(actor, { grantId: draft.id, idempotencyKey: `allocation-policy:${policyId}:auto-propose:${draft.id}` });
  }
  return createBundleForUnbundledProposals(service.repository, actor, policy, policyRunId);
}

export async function approveReviewBundle(service, actor, { bundleId, bundleHash: expectedHash, idempotencyKey }) {
  if (!idempotencyKey) throw new Error('idempotencyKey is required.');
  let bundle = await loadBundle(service.repository, bundleId);
  if (!bundle) throw new Error('Review bundle not found.');
  requireOrgPermission(actor, bundle.foundationOrgId, PERMISSIONS.APPROVE_GRANT);
  if (!['open','partial','approved'].includes(bundle.status)) throw new Error(`Review bundle cannot be approved from status ${bundle.status}.`);
  if (expectedHash !== bundle.bundleHash) throw new Error('Review bundle hash does not match the reviewed bundle. Refresh and review the current bundle.');

  const recalculated = bundleHash({ foundationOrgId: bundle.foundationOrgId, policyId: bundle.policyId, policyVersion: bundle.policyVersion, items: bundle.items });
  if (recalculated !== bundle.bundleHash) throw new Error('Review bundle integrity check failed.');
  const replay = (await service.repository.pool.query('SELECT * FROM grant_review_bundle_commands WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
  if (replay) {
    if (replay.bundle_id !== bundleId || replay.command !== 'approve') throw new Error('idempotencyKey was already used for a different review-bundle command.');
    return loadBundle(service.repository, bundleId);
  }

  for (const item of bundle.items) {
    if (moneyToCents(item.currentAmountCad, 'current grant amount') !== moneyToCents(item.amountCad, 'bundle amount') || item.currentRecipientOrgId !== item.recipientOrgId) {
      throw new Error(`Grant ${item.grantId} changed after the review bundle was created.`);
    }
    if (!['proposed','approved'].includes(item.state)) throw new Error(`Grant ${item.grantId} is ${item.state}; expected proposed or already approved.`);
    if (item.proposedBy === actor.id) throw new Error(`Separation of duties: approver proposed grant ${item.grantId}.`);
  }

  let approvedNow = 0;
  try {
    for (const item of bundle.items) {
      if (item.state === 'approved') continue;
      await service.approveGrant(actor, { grantId: item.grantId, idempotencyKey: `review-bundle:${bundleId}:approve:${item.grantId}` });
      approvedNow += 1;
    }
  } catch (error) {
    await service.repository.pool.query("UPDATE grant_review_bundles SET status='partial',updated_at=now() WHERE id=$1 AND status<>'approved'", [bundleId]);
    throw error;
  }

  bundle = await loadBundle(service.repository, bundleId);
  if (!bundle.items.every(item => item.state === 'approved')) {
    await service.repository.pool.query("UPDATE grant_review_bundles SET status='partial',updated_at=now() WHERE id=$1", [bundleId]);
    throw new Error('Review bundle approval was incomplete; retry the same bundle after inspecting grant states.');
  }

  const client = await service.repository.pool.connect();
  try {
    await client.query('BEGIN');
    const existingCommand = (await client.query('SELECT * FROM grant_review_bundle_commands WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
    if (!existingCommand) {
      await client.query(`INSERT INTO grant_review_bundle_commands (idempotency_key,bundle_id,command) VALUES ($1,$2,'approve')`, [idempotencyKey, bundleId]);
    }
    await client.query(`UPDATE grant_review_bundles SET status='approved',approved_by=$2,approved_at=COALESCE(approved_at,now()),updated_at=now() WHERE id=$1`, [bundleId, actor.id]);
    await appendAudit(service.repository, client, {
      actor,
      organizationId: bundle.foundationOrgId,
      action: 'grant_review_bundle.approved',
      resourceType: 'grant_review_bundle',
      resourceId: bundleId,
      requestId: idempotencyKey,
      payload: { bundleHash: bundle.bundleHash, grantCount: bundle.grantCount, totalCad: bundle.totalCad, approvedNow }
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  return loadBundle(service.repository, bundleId);
}
