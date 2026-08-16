import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverWebsiteContacts,
  extractContactPageLinks,
  extractWebsitePhoneCandidates,
  isPublicAddress,
  normalizeWebsiteUrl,
  robotsAllows
} from '../src/integrations/website_contact.mjs';
import { assessReadiness, loadRuntimeConfig } from '../src/config/requirements.mjs';

test('website URL normalization rejects local/private and credential-bearing targets', () => {
  assert.equal(normalizeWebsiteUrl('example.org/contact').href, 'https://example.org/contact');
  assert.equal(normalizeWebsiteUrl('http://127.0.0.1/contact'), null);
  assert.equal(normalizeWebsiteUrl('http://10.0.0.5'), null);
  assert.equal(normalizeWebsiteUrl('https://user:pass@example.org'), null);
  assert.equal(normalizeWebsiteUrl('https://example.org:8443'), null);
});

test('public-address classifier blocks private, loopback, link-local and documentation ranges', () => {
  for (const address of ['127.0.0.1','10.1.2.3','172.16.9.8','192.168.1.2','169.254.1.2','100.64.0.1','::1','fd00::1','fe80::1','2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('robots rules use longest matching allow/disallow path', () => {
  const robots = `User-agent: *\nDisallow: /private\nAllow: /private/contact\n`;
  assert.equal(robotsAllows(robots, '/'), true);
  assert.equal(robotsAllows(robots, '/private/data'), false);
  assert.equal(robotsAllows(robots, '/private/contact'), true);
});

test('website phone extraction accepts public phone evidence but excludes fax', () => {
  const html = `
    <p>Phone: (514) 555-0123</p>
    <p>Fax: (514) 555-9999</p>
    <a href="tel:+14165550111">Call our Toronto office</a>
  `;
  const candidates = extractWebsitePhoneCandidates(html, 'https://charity.example/contact');
  assert.deepEqual(candidates.map(c => c.destination).sort(), ['+14165550111', '+15145550123']);
  assert.ok(candidates.every(c => c.channel === 'voice'));
});

test('contact-page discovery stays on the same declared site', () => {
  const html = `
    <a href="/contact">Contact us</a>
    <a href="https://www.charity.example/nous-joindre">Nous joindre</a>
    <a href="https://other.example/contact">External contact</a>
    <a href="/donate">Donate</a>
  `;
  const links = extractContactPageLinks(html, 'https://charity.example/', 5).map(url => url.href);
  assert.deepEqual(links.sort(), ['https://charity.example/contact', 'https://www.charity.example/nous-joindre'].sort());
});

test('bounded website discovery follows robots and same-site contact pages', async () => {
  const calls = [];
  const fetchText = async url => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith('/robots.txt')) return { status: 200, url: href, body: 'User-agent: *\nDisallow: /private\n', contentType: 'text/plain' };
    if (href === 'https://charity.example/') return {
      status: 200,
      url: href,
      body: '<a href="/contact">Contact</a><a href="/private/contact">Private</a>',
      contentType: 'text/html'
    };
    if (href === 'https://charity.example/contact') return {
      status: 200,
      url: href,
      body: '<p>Telephone: 613-555-0199</p>',
      contentType: 'text/html'
    };
    throw new Error(`unexpected fetch ${href}`);
  };
  const result = await discoverWebsiteContacts({ website: 'charity.example', fetchText, maxPages: 4 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.pagesVisited, 2);
  assert.deepEqual(result.candidates.map(c => c.destination), ['+16135550199']);
  assert.equal(calls.some(url => url.includes('/private/contact')), false);
});

test('website enrichment readiness fails closed unless the autonomous recipient-delivery stack is enabled', () => {
  const config = loadRuntimeConfig({
    WEBSITE_CONTACT_ENRICHMENT_ENABLED: '1',
    DATABASE_URL: 'postgres://example',
    ENCRYPTION_KEY: 'e'.repeat(40),
    AUDIT_HMAC_KEY: 'a'.repeat(40)
  });
  const assessment = assessReadiness(config);
  assert.equal(assessment.ready, false);
  assert.ok(assessment.blockers.some(item => item.includes('AUTOMATION_ENABLED')));
  assert.ok(assessment.blockers.some(item => item.includes('RECIPIENT_PORTAL_ENABLED')));
});
