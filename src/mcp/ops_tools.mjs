import { z } from 'zod';
import { buildOperationalStatus } from '../ops/status.mjs';

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };

function result(message, data = {}) {
  return { structuredContent: data, content: [{ type: 'text', text: message }] };
}

export function registerOperationalTools(server, { service, actor }) {
  server.registerTool('operational_status', {
    title: 'Clearing-house operational status',
    description: 'Read an organization-scoped clearing-house status snapshot: T3010 load state, automation health, grant states, allocation policies, review/offer queues, recipient-contact verification, compliance, payment intents, reporting backlog, and prioritized attention items. This tool is read-only.',
    inputSchema: {
      organizationId: z.string().uuid().optional()
    },
    annotations: readOnly
  }, async ({ organizationId } = {}) => {
    const status = await buildOperationalStatus({
      repository: service.repository,
      t3010Repository: service.t3010Repository,
      actor,
      organizationId: organizationId || null
    });
    const message = status.attention.length
      ? `Operational snapshot has ${status.attention.length} attention item(s), including ${status.summary.critical} critical and ${status.summary.high} high-priority item(s).`
      : 'Operational snapshot is clear: no current attention items were detected.';
    return result(message, { status });
  });
}
