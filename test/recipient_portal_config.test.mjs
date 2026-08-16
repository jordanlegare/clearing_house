import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';

test('production recipient portal fails closed without HTTPS and secrets', () => {
  const config = loadRuntimeConfig({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://clearing.example.ca',
    DATABASE_URL: 'postgres://db',
    RECIPIENT_PORTAL_ENABLED: '1',
    RECIPIENT_PORTAL_BASE_URL: 'http://offers.example.ca'
  });
  const readiness = assessReadiness(config);
  assert.equal(readiness.ready, false);
  assert.match(readiness.blockers.join(' '), /RECIPIENT_PORTAL_BASE_URL/);
  assert.match(readiness.blockers.join(' '), /AUDIT_HMAC_KEY/);
  assert.match(readiness.blockers.join(' '), /ENCRYPTION_KEY/);
});

test('production recipient portal can pass with HTTPS and application secrets', () => {
  const config = loadRuntimeConfig({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://clearing.example.ca',
    DATABASE_URL: 'postgres://db',
    RECIPIENT_PORTAL_ENABLED: '1',
    RECIPIENT_PORTAL_BASE_URL: 'https://offers.example.ca',
    ENCRYPTION_KEY: 'e'.repeat(40),
    AUDIT_HMAC_KEY: 'a'.repeat(40)
  });
  assert.equal(assessReadiness(config).ready, true);
});

test('recipient capability TTL is bounded to thirty days', () => {
  const config = loadRuntimeConfig({
    DATABASE_URL: 'postgres://db',
    RECIPIENT_PORTAL_ENABLED: '1',
    RECIPIENT_PORTAL_BASE_URL: 'http://localhost:3001',
    ENCRYPTION_KEY: 'e'.repeat(40),
    AUDIT_HMAC_KEY: 'a'.repeat(40),
    OFFER_TOKEN_TTL_HOURS: '721'
  });
  const readiness = assessReadiness(config);
  assert.equal(readiness.ready, false);
  assert.match(readiness.blockers.join(' '), /720/);
});
