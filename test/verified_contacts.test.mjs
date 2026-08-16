import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPhoneCandidates, normalizeCanadianPhone } from '../src/t3010/normalize.mjs';
import { buildContactVerificationUrl } from '../src/workflow/recipient_contacts.mjs';
import { offerBatchHash } from '../src/workflow/offer_batches.mjs';
import { registerWorkflowTools } from '../src/mcp/workflow_tools.mjs';

test('Canadian public phone candidates exclude fax and normalize to E.164', () => {
  assert.equal(normalizeCanadianPhone('(514) 555-0123'), '+15145550123');
  const candidates = extractPhoneCandidates({
    telephone: '(514) 555-0123',
    fax_number: '514-555-9999',
    unrelated_number: '12345'
  });
  assert.deepEqual(candidates.map(c => [c.channel, c.destination]), [
    ['sms', '+15145550123'],
    ['voice', '+15145550123']
  ]);
});

test('contact verification URL carries only the random bearer token', () => {
  const token = 'A'.repeat(43);
  const url = buildContactVerificationUrl('https://offers.example.ca/', token);
  assert.equal(url, `https://offers.example.ca/verify-contact/${token}`);
  assert.equal(url.includes('514'), false);
});

test('offer batch hash binds review bundle, terms and channel', () => {
  const base = {
    reviewBundleId: '00000000-0000-4000-8000-000000000001',
    reviewBundleHash: 'a'.repeat(64),
    termsVersion: 'v1',
    termsText: 'General operating support terms.',
    preferredChannel: 'sms'
  };
  const a = offerBatchHash(base);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, offerBatchHash({ ...base, termsText: 'Changed general operating support terms.' }));
  assert.notEqual(a, offerBatchHash({ ...base, preferredChannel: 'voice' }));
});

test('authenticated MCP surface exposes verified-contact offer batches', () => {
  const tools = new Map();
  const server = { registerTool(name, spec, handler) { tools.set(name, { spec, handler }); } };
  registerWorkflowTools(server, { service: { repository: {} }, actor: null });
  for (const name of ['create_grant_offer_batch','list_grant_offer_batches','get_grant_offer_batch']) {
    assert.equal(tools.has(name), true, `missing ${name}`);
  }
  assert.equal(tools.get('create_grant_offer_batch').spec.annotations.destructiveHint, true);
  assert.equal(tools.get('list_grant_offer_batches').spec.annotations.readOnlyHint, true);
});
