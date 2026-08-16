#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL || 'http://127.0.0.1:3100/mcp');
const client = new Client({ name: 'clearing-house-ci-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map(tool => tool.name));
  for (const required of ['dataset_status', 'search', 'fetch', 'search_charities', 'search_foundations', 'get_foundation_dq_record', 'match_foundation_recipients']) {
    if (!names.has(required)) throw new Error(`MCP tool missing: ${required}`);
  }
  if (names.has('sync_t3010')) throw new Error('sync_t3010 must not be exposed unless ENABLE_T3010_SYNC=1');
  const status = await client.callTool({ name: 'dataset_status', arguments: {} });
  if (!Array.isArray(status.content) || !status.content.length) throw new Error('dataset_status returned no MCP content');
  console.log(JSON.stringify({ connected: true, server: client.getServerVersion?.(), toolCount: tools.length, tools: [...names].sort() }, null, 2));
} finally {
  await client.close().catch(() => {});
}
