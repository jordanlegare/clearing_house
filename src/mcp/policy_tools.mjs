import { z } from 'zod';
import {
  createAllocationPolicy,
  listAllocationPolicies,
  scheduleAllocationPolicyNow,
  setAllocationPolicyEnabled,
  updateAllocationPolicy
} from '../automation/allocation_policies.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const result = (message, data = {}) => ({ structuredContent: data, content: [{ type: 'text', text: message }] });

const policyPatch = z.object({
  title: z.string().min(3).max(200).optional(),
  targetBudgetCad: z.number().positive().max(10_000_000_000).optional(),
  focus: z.string().max(5_000).optional(),
  province: z.string().max(3).optional(),
  minGrantCad: z.number().positive().max(10_000_000_000).optional(),
  maxGrantCad: z.number().positive().max(10_000_000_000).optional(),
  maxRecipients: z.number().int().min(1).max(500).optional(),
  minimumScore: z.number().min(0).max(1).optional(),
  purpose: z.string().min(3).max(10_000).optional(),
  windowStart: z.string().date().optional(),
  windowEnd: z.string().date().optional(),
  refreshIntervalSeconds: z.number().int().min(300).max(604800).optional(),
  autoMaterializeDrafts: z.boolean().optional()
});

export function registerAllocationPolicyTools(server, { repository, actor }) {
  server.registerTool('create_allocation_policy', {
    title: 'Create autonomous allocation policy',
    description: 'Create a bounded foundation allocation envelope that the worker may repeatedly fill with matching grant drafts only. It cannot approve, offer, certify, authorize payment, or transfer money.',
    inputSchema: {
      foundationOrgId: uuid,
      title: z.string().min(3).max(200),
      targetBudgetCad: z.number().positive().max(10_000_000_000),
      focus: z.string().max(5_000).default(''),
      province: z.string().max(3).default(''),
      minGrantCad: z.number().positive().max(10_000_000_000).default(25_000),
      maxGrantCad: z.number().positive().max(10_000_000_000).default(250_000),
      maxRecipients: z.number().int().min(1).max(500).default(100),
      minimumScore: z.number().min(0).max(1).default(0),
      purpose: z.string().min(3).max(10_000).default('General operating support'),
      windowStart: z.string().date(),
      windowEnd: z.string().date(),
      refreshIntervalSeconds: z.number().int().min(300).max(604800).default(3600),
      autoMaterializeDrafts: z.boolean().default(true),
      idempotencyKey
    }, annotations: consequential
  }, async args => result('Created the allocation policy. Autonomous runs may create drafts only within this envelope.', { policy: await createAllocationPolicy(repository, actor, args) }));

  server.registerTool('list_allocation_policies', {
    title: 'List allocation policies',
    description: 'List autonomous draft-allocation policies visible to the authenticated user.',
    inputSchema: { foundationOrgId: uuid.optional() }, annotations: readOnly
  }, async args => result('Returned accessible allocation policies.', { policies: await listAllocationPolicies(repository, actor, args) }));

  server.registerTool('update_allocation_policy', {
    title: 'Update allocation policy',
    description: 'Change an allocation envelope and increment its version. Existing grants remain counted against the target budget.',
    inputSchema: { policyId: uuid, patch: policyPatch, idempotencyKey }, annotations: consequential
  }, async args => result('Updated the allocation policy and scheduled a fresh evaluation.', { policy: await updateAllocationPolicy(repository, actor, args) }));

  server.registerTool('set_allocation_policy_enabled', {
    title: 'Pause or resume allocation policy',
    description: 'Pause or resume autonomous draft preparation for a foundation allocation policy.',
    inputSchema: { policyId: uuid, enabled: z.boolean(), idempotencyKey }, annotations: consequential
  }, async args => result(args.enabled ? 'Resumed the allocation policy.' : 'Paused the allocation policy.', { policy: await setAllocationPolicyEnabled(repository, actor, args) }));

  server.registerTool('run_allocation_policy_now', {
    title: 'Schedule allocation policy now',
    description: 'Move an allocation policy to the front of the autonomous worker queue. This schedules draft planning/materialization only and does not award or pay grants.',
    inputSchema: { policyId: uuid, idempotencyKey }, annotations: consequential
  }, async args => result('Scheduled the allocation policy for the next worker cycle.', { policy: await scheduleAllocationPolicyNow(repository, actor, args) }));
}
