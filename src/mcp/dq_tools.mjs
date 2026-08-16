import { z } from 'zod';
import { suggestDqAllocationEnvelope, createDqBackedAllocationPolicy, getDqPolicyBasis } from '../workflow/dq_envelopes.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const result = (message, data = {}) => ({ structuredContent: data, content: [{ type: 'text', text: message }] });

const envelopeInputs = {
  foundationOrgId: uuid,
  targetFiscalYear: z.number().int().min(2000).max(2100),
  windowStart: z.string().date(),
  windowEnd: z.string().date(),
  mode: z.enum(['auto','tiered_property','flat_scenario']).default('auto'),
  eligiblePropertyCad: z.number().nonnegative().max(100_000_000_000_000).optional(),
  flatRate: z.number().min(0).max(1).default(0.05),
  otherExpectedQualifyingDisbursementsCad: z.number().nonnegative().max(100_000_000_000).default(0),
  includeUnattributedPipeline: z.boolean().default(true)
};

export function registerDqEnvelopeTools(server, { service, actor }) {
  server.registerTool('suggest_dq_allocation_envelope', {
    title: 'Suggest DQ-backed allocation envelope',
    description: 'Build a read-only grant-planning envelope from published Schedule 8 evidence or an explicit current eligible-property assumption, then reconcile it against executed grants, active pipeline and existing allocation policies. Historical public data is not projected beyond its supported fiscal vintage unless an explicit property assumption is supplied.',
    inputSchema: envelopeInputs,
    annotations: readOnly
  }, async args => result('Built a DQ-backed planning envelope. This is not a CRA filing calculation or grant approval.', {
    envelope: await suggestDqAllocationEnvelope(service, actor, args)
  }));

  server.registerTool('create_dq_backed_allocation_policy', {
    title: 'Create allocation policy from reviewed DQ envelope',
    description: 'Create a bounded autonomous draft-allocation policy from an unchanged reviewed DQ envelope snapshot. The requested target cannot exceed the current unreserved modeled capacity. This creates a policy only; it cannot approve or pay grants.',
    inputSchema: {
      ...envelopeInputs,
      suggestionHash: z.string().regex(/^[a-f0-9]{64}$/),
      title: z.string().min(3).max(200),
      targetBudgetCad: z.number().positive().max(10_000_000_000).optional(),
      focus: z.string().max(5_000).default(''),
      province: z.string().max(3).default(''),
      minGrantCad: z.number().positive().max(10_000_000_000).default(25_000),
      maxGrantCad: z.number().positive().max(10_000_000_000).default(250_000),
      maxRecipients: z.number().int().min(1).max(500).default(100),
      minimumScore: z.number().min(0).max(1).default(0),
      purpose: z.string().min(3).max(10_000).default('General operating support'),
      refreshIntervalSeconds: z.number().int().min(300).max(604800).default(3600),
      autoMaterializeDrafts: z.boolean().default(true),
      idempotencyKey
    },
    annotations: consequential
  }, async args => result('Created a DQ-backed allocation policy from the reviewed envelope. The worker may prepare drafts only; approval and payment gates remain separate.', {
    policy: await createDqBackedAllocationPolicy(service, actor, args)
  }));

  server.registerTool('get_dq_policy_basis', {
    title: 'Get DQ policy provenance',
    description: 'Return the stored DQ evidence/assumption snapshot and integrity hash that justified an allocation-policy budget.',
    inputSchema: { policyId: uuid },
    annotations: readOnly
  }, async args => result('Returned the allocation policy budget provenance.', { basis: await getDqPolicyBasis(service, actor, args) }));
}
