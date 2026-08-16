import { z } from 'zod';
import { buildFoundationPortfolio, materializePortfolioDrafts } from '../workflow/portfolio_workflow.mjs';
import { registerAllocationPolicyTools } from './policy_tools.mjs';
import { registerDqEnvelopeTools } from './dq_tools.mjs';
import { registerReviewBundleTools } from './review_tools.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);

function result(message, data = {}) {
  return { structuredContent: data, content: [{ type: 'text', text: message }] };
}

export function registerPortfolioTools(server, { service, actor }) {
  server.registerTool('build_allocation_portfolio', {
    title: 'Build foundation allocation portfolio',
    description: 'Build a read-only recipient allocation plan from a foundation’s T3010 evidence and explicit budget/grant constraints. It reports any unallocated remainder and does not create grants or awards.',
    inputSchema: {
      foundationOrgId: uuid,
      budgetCad: z.number().positive().max(10_000_000_000),
      focus: z.string().max(5_000).default(''),
      province: z.string().max(3).default(''),
      minGrantCad: z.number().positive().max(10_000_000_000).default(25_000),
      maxGrantCad: z.number().positive().max(10_000_000_000).default(250_000),
      maxRecipients: z.number().int().min(1).max(500).default(100),
      minimumScore: z.number().min(0).max(1).default(0),
      purpose: z.string().min(3).max(10_000).default('General operating support')
    },
    annotations: readOnly
  }, async args => result('Built a planning allocation portfolio. No grant drafts or awards were created.', {
    portfolio: await buildFoundationPortfolio(service, actor, args)
  }));

  server.registerTool('create_portfolio_drafts', {
    title: 'Create grant drafts from reviewed portfolio',
    description: 'Create idempotent grant drafts for the explicitly supplied allocations after verifying the integrity hash and recipient BNs against the loaded registered-charity T3010 dataset. The hash is not proof of foundation approval. This action creates drafts only.',
    inputSchema: {
      foundationOrgId: uuid,
      purpose: z.string().min(3).max(10_000),
      allocations: z.array(z.object({
        businessNumber: z.string().min(15).max(20),
        amountCad: z.number().positive().max(10_000_000_000)
      })).min(1).max(500),
      planHash: z.string().regex(/^[a-f0-9]{64}$/),
      idempotencyKey
    },
    annotations: consequential
  }, async args => result('Created grant drafts from the reviewed allocation plan. No grants were proposed, approved, offered, notified, or paid.', {
    portfolioDrafts: await materializePortfolioDrafts(service, actor, args)
  }));

  registerAllocationPolicyTools(server, { repository: service.repository, actor });
  registerDqEnvelopeTools(server, { service, actor });
  registerReviewBundleTools(server, { service, actor });
}
