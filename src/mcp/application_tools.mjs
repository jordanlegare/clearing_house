import { z } from 'zod';
import { jsonStringLeavesWithin } from '../applications/package.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const write = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const stringArray = z.array(z.string().min(1).max(2_000)).max(100);
const objectArray = z.array(z.record(z.any())).max(100)
  .refine(value => jsonStringLeavesWithin(value), 'nested text exceeds 10000 characters')
  .refine(value => JSON.stringify(value).length <= 50_000, 'array exceeds 50KB');
const boundedObject = z.record(z.any())
  .refine(value => jsonStringLeavesWithin(value), 'nested text exceeds 10000 characters')
  .refine(value => JSON.stringify(value).length <= 50_000, 'object exceeds 50KB');
const result = (message, data = {}) => ({ structuredContent: data, content: [{ type: 'text', text: message }] });

const profileFields = {
  mission: z.string().max(10_000).default(''),
  activities: stringArray.default([]),
  populations: stringArray.default([]),
  geography: stringArray.default([]),
  outcomes: objectArray.default([]),
  governance: boundedObject.default({}),
  financialSummary: boundedObject.default({}),
  evidence: objectArray.default([])
};

const requestFields = {
  title: z.string().min(2).max(500),
  purpose: z.string().min(3).max(10_000),
  amountCad: z.number().positive().max(10_000_000_000),
  objectives: stringArray.default([]),
  activities: stringArray.default([]),
  outcomes: objectArray.default([]),
  budget: z.array(z.object({ label: z.string().min(1).max(500), amountCad: z.number().nonnegative() })).max(100).default([]),
  geography: stringArray.default([]),
  populations: stringArray.default([]),
  evidence: objectArray.default([])
};

export function registerApplicationTools(server, { workspace, actor }) {
  server.registerTool('get_recipient_funding_profile', {
    title: 'Get reusable recipient funding profile',
    description: 'Return the authenticated recipient organization’s reusable, versioned grant-funding facts and evidence references.',
    inputSchema: { recipientOrgId: uuid },
    annotations: readOnly
  }, async args => result('Returned the recipient funding profile.', { profile: await workspace.getProfile(actor, args) }));

  server.registerTool('upsert_recipient_funding_profile', {
    title: 'Create or update recipient funding profile',
    description: 'Store recipient-approved organizational facts for reuse in foundation screening and grounded application packages. Missing facts remain missing; ChatGPT must not invent them.',
    inputSchema: {
      recipientOrgId: uuid,
      expectedVersion: z.number().int().nonnegative().optional(),
      ...profileFields,
      idempotencyKey
    },
    annotations: write
  }, async args => result('Stored the recipient-approved funding profile.', { profile: await workspace.upsertProfile(actor, args) }));

  server.registerTool('create_recipient_funding_request', {
    title: 'Create reusable recipient funding request',
    description: 'Create a project or operating request once for reuse in transparent foundation screening and application packages. This does not contact a foundation.',
    inputSchema: { recipientOrgId: uuid, ...requestFields, idempotencyKey },
    annotations: write
  }, async args => result('Created the reusable recipient funding request. No foundation was contacted.', { request: await workspace.createRequest(actor, args) }));

  server.registerTool('update_recipient_funding_request', {
    title: 'Update reusable recipient funding request',
    description: 'Update an active request using optimistic version control. Existing application snapshots remain unchanged.',
    inputSchema: {
      recipientOrgId: uuid,
      requestId: uuid,
      expectedVersion: z.number().int().positive(),
      ...requestFields,
      idempotencyKey
    },
    annotations: write
  }, async args => result('Updated the reusable funding request. Existing application snapshots were not changed.', { request: await workspace.updateRequest(actor, args) }));

  server.registerTool('list_recipient_funding_requests', {
    title: 'List recipient funding requests',
    description: 'List active or archived reusable funding requests for an accessible recipient organization.',
    inputSchema: {
      recipientOrgId: uuid,
      status: z.enum(['active', 'archived', 'all']).default('active'),
      limit: z.number().int().min(1).max(200).default(50)
    },
    annotations: readOnly
  }, async args => result('Returned recipient funding requests.', { requests: await workspace.listRequests(actor, args) }));

  server.registerTool('match_recipient_foundations', {
    title: 'Screen foundations for a recipient request',
    description: 'Rank Canadian foundations using transparent overlap with recipient-approved facts and T3010/historical evidence. Screening only: verify current guidelines, eligibility, geography, deadlines, application channels, agreements and reporting requirements.',
    inputSchema: {
      recipientOrgId: uuid,
      fundingRequestId: uuid,
      province: z.string().max(3).default(''),
      minimumSupportSignalCad: z.number().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(25)
    },
    annotations: readOnly
  }, async args => result('Returned transparent foundation screening matches. Historical support is not a current grant budget or eligibility decision.', {
    matching: await workspace.matchFoundations(actor, args)
  }));

  server.registerTool('prepare_grant_application', {
    title: 'Prepare foundation-specific grant application',
    description: 'Build and store a deterministic, hash-bound application package from recipient-approved facts and filing-derived foundation evidence. This prepares a draft only and does not submit it.',
    inputSchema: {
      recipientOrgId: uuid,
      fundingRequestId: uuid,
      foundationBn: z.string().min(15).max(20),
      province: z.string().max(3).default(''),
      idempotencyKey
    },
    annotations: write
  }, async args => result('Prepared a grounded application draft and readiness checklist. Nothing was submitted.', {
    application: await workspace.prepareApplication(actor, args)
  }));

  server.registerTool('list_grant_applications', {
    title: 'List recipient grant applications',
    description: 'List application drafts, external submissions and recipient-reported outcomes for an accessible recipient organization.',
    inputSchema: {
      recipientOrgId: uuid,
      status: z.enum(['draft', 'ready', 'submitted', 'awarded', 'declined', 'withdrawn', 'all']).default('all'),
      limit: z.number().int().min(1).max(200).default(50)
    },
    annotations: readOnly
  }, async args => result('Returned recipient grant applications.', { applications: await workspace.listApplications(actor, args) }));

  server.registerTool('get_grant_application', {
    title: 'Get recipient grant application',
    description: 'Return one accessible hash-bound application package, readiness findings, external submission evidence and the current recipient-reported outcome.',
    inputSchema: { applicationId: uuid },
    annotations: readOnly
  }, async args => result('Returned the recipient grant application.', { application: await workspace.getApplication(actor, args) }));

  server.registerTool('mark_grant_application_ready', {
    title: 'Mark grant application ready',
    description: 'Recipient-admin action to freeze an unchanged, complete application package for recipient-controlled external filing. This does not submit the application.',
    inputSchema: {
      applicationId: uuid,
      packageHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmation: z.literal('MARK APPLICATION READY'),
      idempotencyKey
    },
    annotations: consequential
  }, async args => result('Marked the unchanged application package ready for recipient-controlled filing. Nothing was submitted.', {
    application: await workspace.transitionApplication(actor, { ...args, nextStatus: 'ready' })
  }));

  server.registerTool('record_grant_application_submission', {
    title: 'Record external foundation application submission',
    description: 'Record recipient-provided evidence after the recipient actually files through a foundation channel. This tool does not contact the foundation and does not prove receipt or acceptance.',
    inputSchema: {
      applicationId: uuid,
      submissionChannel: z.string().min(2).max(200),
      externalSubmissionReference: z.string().min(1).max(500),
      submittedAt: z.string().datetime(),
      idempotencyKey
    },
    annotations: consequential
  }, async args => result('Recorded recipient-provided evidence of an external foundation submission. This does not prove receipt or acceptance.', {
    application: await workspace.transitionApplication(actor, { ...args, nextStatus: 'submitted' })
  }));

  server.registerTool('record_grant_application_outcome', {
    title: 'Record recipient-reported application outcome',
    description: 'Record an awarded, declined or withdrawn application outcome and rationale. An awarded outcome does not create a foundation-side grant or imply payment.',
    inputSchema: {
      applicationId: uuid,
      outcome: z.enum(['awarded', 'declined', 'withdrawn']),
      rationale: z.string().min(1).max(10_000),
      decidedAt: z.string().datetime(),
      idempotencyKey
    },
    annotations: consequential
  }, async ({ outcome, ...args }) => result('Recorded the recipient-reported application outcome. No grant-award workflow record was created.', {
    application: await workspace.transitionApplication(actor, { ...args, nextStatus: outcome })
  }));
}
