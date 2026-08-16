import { WorkflowService } from '../workflow/workflow_service.mjs';
import { preparePolicyReviewBundle } from '../workflow/review_bundles.mjs';

async function actorForUser(repository, userId) {
  const user = (await repository.pool.query('SELECT id,oidc_subject,email,display_name FROM users WHERE id=$1', [userId])).rows[0];
  if (!user) throw new Error('Allocation policy creator user no longer exists.');
  const [global, memberships] = await Promise.all([
    repository.pool.query('SELECT role FROM user_global_roles WHERE user_id=$1', [userId]),
    repository.pool.query('SELECT organization_id,role FROM memberships WHERE user_id=$1', [userId])
  ]);
  return {
    id: user.id,
    subject: user.oidc_subject,
    email: user.email,
    displayName: user.display_name,
    roles: global.rows.map(row => row.role),
    memberships: memberships.rows.map(row => ({ organizationId: row.organization_id, role: row.role }))
  };
}

export async function runReviewBundlesJob({ config, repository }) {
  if (!config.automatedPortfoliosEnabled) return { skipped: true, reason: 'automated_portfolios_disabled' };
  const { rows } = await repository.pool.query(`
    SELECT p.id,p.created_by
    FROM foundation_allocation_policies p
    JOIN foundation_allocation_policy_execution_options o ON o.policy_id=p.id
    WHERE p.enabled=true AND o.auto_propose_drafts=true
    ORDER BY p.updated_at,p.id
    LIMIT $1
  `, [config.allocationPolicyBatchSize]);
  const results = [];
  for (const policy of rows) {
    try {
      const actor = await actorForUser(repository, policy.created_by);
      const service = new WorkflowService({ repository, t3010Repository: null, config });
      const bundle = await preparePolicyReviewBundle(service, actor, { policyId: policy.id });
      results.push({ policyId: policy.id, status: 'success', bundleId: bundle?.id || null, proposedOrBundled: Boolean(bundle) });
    } catch (error) {
      results.push({ policyId: policy.id, status: 'failed', error: error.message });
    }
  }
  return { processed: results.length, results };
}
