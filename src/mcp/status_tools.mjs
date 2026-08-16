import { z } from 'zod';
import {
  confirmStatusVerificationTask,
  getStatusVerificationTask,
  listStatusVerificationTasks
} from '../workflow/status_verification_tasks.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const consequential = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };

function result(message, data = {}) {
  return { structuredContent: data, content: [{ type: 'text', text: message }] };
}

export function registerStatusVerificationTools(server, { service, actor }) {
  server.registerTool('list_status_verification_tasks', {
    title: 'List current CRA status-verification tasks',
    description: 'List organization-scoped grants whose current CRA registration status must be confirmed before payment authorization. Public revocation evidence is pre-collected, but absence from the revocations page is never treated as proof of registration.',
    inputSchema: {
      foundationOrgId: z.string().uuid().optional(),
      status: z.enum(['pending','manual_confirmation_required','revocation_evidence_found','completed']).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    },
    annotations: readOnly
  }, async args => {
    const tasks = await listStatusVerificationTasks(service.repository, actor, args || {});
    return result(`Found ${tasks.length} current-status verification task(s).`, { tasks });
  });

  server.registerTool('get_status_verification_task', {
    title: 'Get CRA status-verification evidence packet',
    description: 'Get one grant’s current-status verification packet, including BN, recipient, public revocation evidence and the authoritative CRA List of charities URL that a permitted reviewer must use for current confirmation.',
    inputSchema: { taskId: z.string().uuid() },
    annotations: readOnly
  }, async ({ taskId }) => result('Loaded the current-status verification evidence packet. A human confirmation in the current CRA List of charities is still required unless positive revocation evidence already blocks the grant.', {
    task: await getStatusVerificationTask(service.repository, actor, taskId)
  }));

  server.registerTool('confirm_status_verification_task', {
    title: 'Record current CRA status from verification task',
    description: 'After an authorized reviewer has checked the current CRA List of charities, record the observed status using the task’s pre-collected evidence and close the task. This is a consequential compliance record and does not authorize payment by itself.',
    inputSchema: {
      taskId: z.string().uuid(),
      observedStatus: z.enum(['registered','revoked','annulled','suspended','penalized','unknown']),
      idempotencyKey: z.string().min(8).max(200)
    },
    annotations: consequential
  }, async args => result('Recorded the reviewer-confirmed CRA status and completed the verification task. Payment remains subject to all downstream gates.', {
    task: await confirmStatusVerificationTask(service, actor, args)
  }));
}
