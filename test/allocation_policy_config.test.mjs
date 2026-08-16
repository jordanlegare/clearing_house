import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';

test('automated allocation policies fail closed without automation, workflow writes and audit key', () => {
  const config = loadRuntimeConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://db',
    AUTOMATED_PORTFOLIOS_ENABLED: '1'
  });
  const readiness = assessReadiness(config);
  assert.equal(readiness.ready, false);
  assert.match(readiness.blockers.join(' '), /AUTOMATION_ENABLED/);
  assert.match(readiness.blockers.join(' '), /ENABLE_WORKFLOW_WRITES/);
  assert.match(readiness.blockers.join(' '), /AUDIT_HMAC_KEY/);
});

test('automated allocation policy readiness can pass with bounded operator configuration', () => {
  const config = loadRuntimeConfig({
    DATABASE_URL: 'postgres://db',
    AUTOMATION_ENABLED: '1',
    ENABLE_WORKFLOW_WRITES: '1',
    AUTOMATED_PORTFOLIOS_ENABLED: '1',
    AUDIT_HMAC_KEY: 'a'.repeat(40),
    ALLOCATION_POLICY_POLL_SECONDS: '300',
    ALLOCATION_POLICY_BATCH_SIZE: '10'
  });
  assert.equal(assessReadiness(config).ready, true);
});

test('automated allocation batch and poll rates are bounded', () => {
  let config = loadRuntimeConfig({ DATABASE_URL:'postgres://db',AUTOMATION_ENABLED:'1',ENABLE_WORKFLOW_WRITES:'1',AUTOMATED_PORTFOLIOS_ENABLED:'1',AUDIT_HMAC_KEY:'a'.repeat(40),ALLOCATION_POLICY_POLL_SECONDS:'30' });
  assert.match(assessReadiness(config).blockers.join(' '), /at least 60/);
  config = loadRuntimeConfig({ DATABASE_URL:'postgres://db',AUTOMATION_ENABLED:'1',ENABLE_WORKFLOW_WRITES:'1',AUTOMATED_PORTFOLIOS_ENABLED:'1',AUDIT_HMAC_KEY:'a'.repeat(40),ALLOCATION_POLICY_BATCH_SIZE:'101' });
  assert.match(assessReadiness(config).blockers.join(' '), /cannot exceed 100/);
});
