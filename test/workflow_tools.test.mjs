import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWorkflowTools } from '../src/mcp/workflow_tools.mjs';

test('authenticated workflow exposes explicit, permission-separable MCP actions', () => {
  const tools = new Map();
  const server = { registerTool(name, spec, handler) { tools.set(name, { spec, handler }); } };
  registerWorkflowTools(server, { service: { repository: {} }, actor: null });
  for (const name of [
    'workflow_whoami','build_allocation_portfolio','create_portfolio_drafts',
    'create_allocation_policy','list_allocation_policies','update_allocation_policy','set_allocation_policy_enabled','run_allocation_policy_now',
    'suggest_dq_allocation_envelope','create_dq_backed_allocation_policy','get_dq_policy_basis',
    'get_allocation_policy_execution_options','set_allocation_policy_execution_options',
    'list_grant_review_bundles','get_grant_review_bundle','approve_grant_review_bundle',
    'claim_recipient_organization','claim_foundation_organization','verify_organization_claim',
    'grant_organization_role','create_grant','propose_grant','approve_grant','offer_grant','accept_grant',
    'check_cra_public_evidence','record_cra_status_verification','prepare_nqd_diligence','get_nqd_diligence',
    'approve_nqd_diligence','review_grant_compliance','record_banking_verification','create_manual_payment_intent',
    'authorize_manual_payment','record_manual_payment','prepare_reporting_record','mark_grant_reported'
  ]) assert.equal(tools.has(name), true, `missing ${name}`);
  assert.equal(tools.get('workflow_whoami').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('build_allocation_portfolio').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('list_allocation_policies').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('suggest_dq_allocation_envelope').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('get_dq_policy_basis').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('get_allocation_policy_execution_options').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('list_grant_review_bundles').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('get_grant_review_bundle').spec.annotations.readOnlyHint, true);
  assert.equal(tools.get('create_portfolio_drafts').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('create_allocation_policy').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('create_dq_backed_allocation_policy').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('set_allocation_policy_execution_options').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('approve_grant_review_bundle').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('run_allocation_policy_now').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('check_cra_public_evidence').spec.annotations.openWorldHint, true);
  assert.equal(tools.get('create_grant').spec.annotations.readOnlyHint, false);
  assert.equal(tools.get('prepare_nqd_diligence').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('create_manual_payment_intent').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('authorize_manual_payment').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('verify_organization_claim').spec.annotations.destructiveHint, true);
});
