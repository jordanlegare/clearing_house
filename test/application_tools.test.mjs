import test from 'node:test';
import assert from 'node:assert/strict';
import { registerApplicationTools } from '../src/mcp/application_tools.mjs';

test('recipient funding tools expose scoped reads, idempotent writes and consequential filing evidence', async () => {
  const tools = new Map();
  const server = { registerTool(name, spec, handler) { tools.set(name, { spec, handler }); } };
  const calls = [];
  const workspace = new Proxy({}, {
    get(_target, method) {
      return async (_actor, args) => {
        calls.push({ method: String(method), args });
        return { method: String(method), ...args };
      };
    }
  });
  registerApplicationTools(server, { workspace, actor: { id: 'recipient-user' } });

  const names = [
    'get_recipient_funding_profile',
    'upsert_recipient_funding_profile',
    'create_recipient_funding_request',
    'update_recipient_funding_request',
    'list_recipient_funding_requests',
    'match_recipient_foundations',
    'prepare_grant_application',
    'list_grant_applications',
    'get_grant_application',
    'mark_grant_application_ready',
    'record_grant_application_submission',
    'record_grant_application_outcome'
  ];
  assert.deepEqual([...tools.keys()], names);

  for (const name of [
    'get_recipient_funding_profile',
    'list_recipient_funding_requests',
    'match_recipient_foundations',
    'list_grant_applications',
    'get_grant_application'
  ]) {
    assert.equal(tools.get(name).spec.annotations.readOnlyHint, true, `${name} should be read-only`);
    assert.equal(tools.get(name).spec.annotations.destructiveHint, false, `${name} should not be consequential`);
  }

  for (const name of [
    'upsert_recipient_funding_profile',
    'create_recipient_funding_request',
    'update_recipient_funding_request',
    'prepare_grant_application',
    'mark_grant_application_ready',
    'record_grant_application_submission',
    'record_grant_application_outcome'
  ]) assert.ok(tools.get(name).spec.inputSchema.idempotencyKey, `${name} must require an idempotency key`);

  for (const name of [
    'mark_grant_application_ready',
    'record_grant_application_submission',
    'record_grant_application_outcome'
  ]) assert.equal(tools.get(name).spec.annotations.destructiveHint, true, `${name} should be consequential`);

  const budgetSchema = tools.get('create_recipient_funding_request').spec.inputSchema.budget;
  assert.equal(budgetSchema.safeParse(Array.from({ length: 100 }, (_, index) => ({
    label: `Line ${index + 1}`, amountCad: 1
  }))).success, true);
  assert.equal(budgetSchema.safeParse(Array.from({ length: 101 }, (_, index) => ({
    label: `Line ${index + 1}`, amountCad: 1
  }))).success, false);
  const outcomesSchema = tools.get('create_recipient_funding_request').spec.inputSchema.outcomes;
  assert.equal(outcomesSchema.safeParse([{ description: 'x'.repeat(10_000) }]).success, true);
  assert.equal(outcomesSchema.safeParse([{ description: 'x'.repeat(10_001) }]).success, false);

  const result = await tools.get('record_grant_application_submission').handler({
    applicationId: '00000000-0000-4000-8000-000000000001',
    submissionChannel: 'foundation_portal',
    externalSubmissionReference: 'portal-reference-1',
    submittedAt: '2026-08-16T20:05:00.000Z',
    idempotencyKey: 'submission-key-1'
  });
  assert.equal(calls[0].method, 'transitionApplication');
  assert.equal(calls[0].args.nextStatus, 'submitted');
  assert.match(result.content[0].text, /does not prove receipt or acceptance/i);
});
