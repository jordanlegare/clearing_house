import { z } from 'zod';
import {
  approveReviewBundle,
  getPolicyExecutionOptions,
  getReviewBundle,
  listReviewBundles,
  setPolicyExecutionOptions
} from '../workflow/review_bundles.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const result = (message, data = {}) => ({ structuredContent: data, content: [{ type: 'text', text: message }] });

export function registerReviewBundleTools(server, { service, actor }) {
  server.registerTool('get_allocation_policy_execution_options', {
    title: 'Get allocation policy execution options',
    description: 'Show whether a policy has explicitly pre-authorized the worker to move its machine-prepared draft grants into proposed state. Automatic approval is never supported.',
    inputSchema: { policyId: uuid },
    annotations: readOnly
  }, async args => result('Returned allocation-policy execution options.', {
    options: await getPolicyExecutionOptions(service.repository, actor, args)
  }));

  server.registerTool('set_allocation_policy_execution_options', {
    title: 'Set allocation policy execution options',
    description: 'Explicitly enable or disable automatic draft-to-proposed transitions for a bounded allocation policy. Enabling this lets the policy creator’s current authority propose machine-prepared drafts and bundle them for separate approval; it never auto-approves grants.',
    inputSchema: { policyId: uuid, autoProposeDrafts: z.boolean(), idempotencyKey },
    annotations: consequential
  }, async args => result(args.autoProposeDrafts
    ? 'Enabled automatic proposal preparation for this policy. Separate bundle approval remains required.'
    : 'Disabled automatic proposal preparation for this policy.', {
    options: await setPolicyExecutionOptions(service.repository, actor, args)
  }));

  server.registerTool('list_grant_review_bundles', {
    title: 'List grant review bundles',
    description: 'List immutable proposal bundles visible to the authenticated foundation user.',
    inputSchema: {
      foundationOrgId: uuid.optional(),
      status: z.enum(['open','partial','approved','cancelled']).optional(),
      limit: z.number().int().min(1).max(200).default(50)
    },
    annotations: readOnly
  }, async args => result('Returned grant review bundles.', {
    bundles: await listReviewBundles(service.repository, actor, args)
  }));

  server.registerTool('get_grant_review_bundle', {
    title: 'Get grant review bundle',
    description: 'Return the complete immutable recipient/amount snapshot and current grant states for one review bundle.',
    inputSchema: { bundleId: uuid },
    annotations: readOnly
  }, async args => result('Returned the grant review bundle.', {
    bundle: await getReviewBundle(service.repository, actor, args)
  }));

  server.registerTool('approve_grant_review_bundle', {
    title: 'Approve grant review bundle',
    description: 'Approve every unchanged proposed grant in a reviewed bundle in one action. The supplied SHA-256 bundle hash must match, every grant is preflighted, and the approver cannot be the proposer of any grant. This does not offer, notify, certify compliance, authorize payment, or move money.',
    inputSchema: { bundleId: uuid, bundleHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey },
    annotations: consequential
  }, async args => result('Approved the unchanged proposal bundle. Grants are approved but have not been offered to recipients or paid.', {
    bundle: await approveReviewBundle(service, actor, args)
  }));
}
