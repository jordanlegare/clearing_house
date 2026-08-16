import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmailCandidates, normalizeEmail } from '../src/t3010/normalize.mjs';
import { normalizeContactDestination } from '../src/workflow/recipient_contacts.mjs';
import { extractWebsiteEmailCandidates } from '../src/integrations/website_email_contact.mjs';
import { createNotificationProvider } from '../src/integrations/notification.mjs';
import { assessReadiness, loadRuntimeConfig } from '../src/config/requirements.mjs';


test('public email candidates normalize and reject malformed addresses', () => {
  assert.equal(normalizeEmail(' Grants.Team@Example.CA '), 'grants.team@example.ca');
  assert.equal(normalizeContactDestination('email', 'MAILTO:Info@Example.ca?subject=Hello'), 'info@example.ca');
  assert.equal(normalizeEmail('not an email'), null);
  assert.equal(normalizeEmail('a..b@example.ca'), null);
  const candidates = extractEmailCandidates({
    public_email: 'Programs@Example.ca',
    telephone: '514-555-0123',
    contact_email_address: 'programs@example.ca; finance@example.ca'
  });
  assert.deepEqual(candidates.map(candidate => candidate.destination), ['programs@example.ca', 'finance@example.ca']);
  assert.ok(candidates.every(candidate => candidate.channel === 'email'));
});


test('website email discovery extracts mailto and visible public addresses without duplicates', () => {
  const html = `
    <html><body>
      <a href="mailto:hello@charity.ca?subject=Funding">Email us</a>
      <p>Programs: programs@charity.ca</p>
      <p>Again: HELLO@CHARITY.CA</p>
    </body></html>`;
  const candidates = extractWebsiteEmailCandidates(html, 'https://charity.ca/contact');
  assert.deepEqual(candidates.map(candidate => candidate.destination), ['hello@charity.ca', 'programs@charity.ca']);
  assert.deepEqual(candidates.map(candidate => candidate.extraction), ['mailto_link', 'page_text']);
});


test('Resend adapter uses authenticated HTTPS email API and provider idempotency', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() { return { id: 'email_123' }; }
    };
  };
  try {
    const provider = createNotificationProvider({
      notificationProvider: 'disabled',
      emailProvider: 'resend',
      resendApiKey: 're_test_key',
      resendFromEmail: 'Clearing House <grants@example.ca>'
    });
    const result = await provider.send({
      channel: 'email',
      to: 'recipient@example.ca',
      subject: 'Funding offer for your organization',
      body: 'Secure offer link',
      idempotencyKey: 'contact-verification:00000000-0000-4000-8000-000000000001'
    });
    assert.equal(result.providerMessageId, 'email_123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.authorization, 'Bearer re_test_key');
    assert.equal(calls[0].options.headers['idempotency-key'], 'contact-verification:00000000-0000-4000-8000-000000000001');
    assert.match(calls[0].options.headers['user-agent'], /CanadianPhilanthropyClearingHouse/);
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body.to, ['recipient@example.ca']);
    assert.equal(body.from, 'Clearing House <grants@example.ca>');
    assert.equal(body.text, 'Secure offer link');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('Resend readiness fails closed without sender credentials', () => {
  const bad = assessReadiness(loadRuntimeConfig({ EMAIL_PROVIDER: 'resend', ENCRYPTION_KEY: 'e'.repeat(40) }));
  assert.equal(bad.ready, false);
  assert.ok(bad.blockers.some(value => value.includes('RESEND_API_KEY')));
  assert.ok(bad.blockers.some(value => value.includes('RESEND_FROM_EMAIL')));

  const good = assessReadiness(loadRuntimeConfig({
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'grants@example.ca',
    ENCRYPTION_KEY: 'e'.repeat(40)
  }));
  assert.equal(good.blockers.some(value => value.includes('Resend')), false);
});
