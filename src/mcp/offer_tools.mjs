import { z } from 'zod';
import { createOfferBatch, getOfferBatch, listOfferBatches } from '../workflow/offer_batches.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const result = (message, data = {}) => ({ structuredContent: data, content: [{ type: 'text', text: message }] });

export function registerOfferBatchTools(server, { service, actor }) {
  server.registerTool('create_grant_offer_batch', {
    title: 'Create recipient offer batch',
    description: 'Attach one reviewed terms version to an approved grant review bundle. The autonomous worker will use only verified recipient contact channels; unverified public T3010 contacts receive a separate verification challenge first. Creating the batch does not itself accept grants or move money.',
    inputSchema: {
      reviewBundleId: uuid,
      termsVersion: z.string().min(1).max(100),
      termsText: z.string().min(10).max(50_000),
      preferredChannel: z.enum(['sms','voice']).default('sms'),
      idempotencyKey
    },
    annotations: consequential
  }, async args => result('Created the recipient offer batch. The worker can now verify recipient channels and deliver offers without further foundation data entry.', {
    batch: await createOfferBatch(service, actor, args)
  }));

  server.registerTool('list_grant_offer_batches', {
    title: 'List recipient offer batches',
    description: 'List verified-contact offer batches visible to the authenticated foundation user.',
    inputSchema: {
      foundationOrgId: uuid.optional(),
      status: z.enum(['pending_contacts','ready','offering','offered','partial','cancelled']).optional(),
      limit: z.number().int().min(1).max(200).default(50)
    },
    annotations: readOnly
  }, async args => result('Returned recipient offer batches.', { batches: await listOfferBatches(service.repository, actor, args) }));

  server.registerTool('get_grant_offer_batch', {
    title: 'Get recipient offer batch',
    description: 'Return recipient contact-verification and offer-delivery state for one batch without exposing raw contact destinations.',
    inputSchema: { batchId: uuid },
    annotations: readOnly
  }, async args => result('Returned the recipient offer batch.', { batch: await getOfferBatch(service.repository, actor, args) }));
}
