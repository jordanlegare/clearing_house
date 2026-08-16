import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { normalizeCanadianPhone } from '../t3010/normalize.mjs';
import { upsertRecipientContactCandidate } from '../workflow/recipient_contacts.mjs';

const CONTACT_HINT = /(contact|contact-us|contactez|nous-joindre|nousjoindre|coordonn|about|a-propos|apropos|reach-us|connect)/i;
const PHONE_CONTEXT = /(phone|telephone|t[ée]l[ée]?phone|tel\.?|call|contact|appelez|mobile|cell)/i;
const FAX_LABEL = /(?:fax|facsimile|t[ée]l[ée]cop(?:ieur)?)\s*[:.\-]?\s*$/i;
const USER_AGENT = 'CanadianPhilanthropyClearingHouse/1.0 (+public-contact-discovery)';

function stripWww(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

function sameSiteHost(a, b) {
  return stripWww(a) === stripWww(b);
}

function ipv4Parts(address) {
  const parts = String(address).split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 4) {
    const p = ipv4Parts(address);
    if (!p) return false;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && (p[1] === 0 || p[1] === 168)) return false;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
    if (p[0] >= 224) return false;
    return true;
  }
  const value = String(address).toLowerCase();
  if (value === '::' || value === '::1') return false;
  if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff')) return false;
  if (value.startsWith('2001:db8:')) return false;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPublicAddress(mapped[1]) : true;
}

export function normalizeWebsiteUrl(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (url.port && !['80', '443'].includes(url.port)) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (net.isIP(host) && !isPublicAddress(host)) return null;
  url.hash = '';
  return url;
}

async function resolvePublicHost(hostname, resolver = dns.lookup) {
  const records = await resolver(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) throw new Error('Website hostname did not resolve.');
  if (records.some(record => !isPublicAddress(record.address))) throw new Error('Website hostname resolves to a non-public address.');
  return records[0];
}

export async function safeFetchText(input, {
  timeoutMs = 5000,
  maxBytes = 524288,
  maxRedirects = 3,
  resolver = dns.lookup,
  userAgent = USER_AGENT
} = {}) {
  const initial = input instanceof URL ? new URL(input.href) : normalizeWebsiteUrl(input);
  if (!initial) throw new Error('Website URL is invalid or unsafe.');

  async function requestUrl(url, redirectsLeft) {
    const resolved = await resolvePublicHost(url.hostname, resolver);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        family: resolved.family,
        lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
        servername: url.hostname,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
          connection: 'close'
        }
      }, response => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) return reject(new Error('Website redirect limit exceeded.'));
          let next;
          try { next = new URL(response.headers.location, url); } catch { return reject(new Error('Website returned an invalid redirect.')); }
          const safe = normalizeWebsiteUrl(next.href);
          if (!safe || !sameSiteHost(url.hostname, safe.hostname)) return reject(new Error('Website redirected outside the declared site.'));
          requestUrl(safe, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (status < 200 || status >= 300) {
          response.resume();
          resolve({ url: url.href, status, contentType, body: '' });
          return;
        }
        if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml+xml')) {
          response.resume();
          reject(new Error(`Website returned unsupported content type: ${contentType}`));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) return req.destroy(new Error('Website response exceeded byte limit.'));
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ url: url.href, status, contentType, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Website request timed out.')));
      req.on('error', reject);
      req.end();
    });
  }

  return requestUrl(initial, Math.min(Math.max(Number(maxRedirects) || 0, 0), 5));
}

function robotsGroups(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ type: key, path: value });
    }
  }
  return groups;
}

export function robotsAllows(text, pathname, userAgent = USER_AGENT) {
  const groups = robotsGroups(text);
  const agent = userAgent.toLowerCase();
  const named = groups.filter(group => group.agents.some(value => value !== '*' && agent.includes(value)));
  const selected = named.length ? named : groups.filter(group => group.agents.includes('*'));
  let winner = null;
  for (const rule of selected.flatMap(group => group.rules).filter(rule => rule.path)) {
    if (!pathname.startsWith(rule.path)) continue;
    if (!winner || rule.path.length > winner.path.length || (rule.path.length === winner.path.length && rule.type === 'allow')) winner = rule;
  }
  return !winner || winner.type === 'allow';
}

function stripMarkup(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

function addCandidate(out, seen, phone, sourceUrl, extraction) {
  const normalized = normalizeCanadianPhone(phone);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  out.push({ channel: 'voice', destination: normalized, sourceUrl, extraction });
}

export function extractWebsitePhoneCandidates(html, sourceUrl) {
  const out = [];
  const seen = new Set();
  const source = String(html || '');
  for (const match of source.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    addCandidate(out, seen, decodeURIComponent(match[1].split('?')[0]), sourceUrl, 'tel_link');
  }
  const text = stripMarkup(source);
  const phonePattern = /(?:\+?1[\s.()\-]*)?(?:\(?\d{3}\)?[\s.\-]*)\d{3}[\s.\-]*\d{4}/g;
  const contactPage = CONTACT_HINT.test(new URL(sourceUrl).pathname);
  for (const match of text.matchAll(phonePattern)) {
    const index = match.index || 0;
    const before = text.slice(Math.max(0, index - 48), index);
    const after = text.slice(index + match[0].length, Math.min(text.length, index + match[0].length + 48));
    if (FAX_LABEL.test(before.slice(-32))) continue;
    if (!contactPage && !PHONE_CONTEXT.test(`${before} ${after}`)) continue;
    addCandidate(out, seen, match[0], sourceUrl, 'page_text');
  }
  return out;
}

export function extractContactPageLinks(html, baseUrl, limit = 3) {
  const base = new URL(baseUrl);
  const scored = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].replace(/&amp;/gi, '&').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || !sameSiteHost(base.hostname, url.hostname)) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    const signal = `${url.pathname} ${stripMarkup(match[2])}`;
    if (!CONTACT_HINT.test(signal)) continue;
    seen.add(url.href);
    scored.push({ url, score: /(contact|nous-joindre|contactez|coordonn|reach-us)/i.test(signal) ? 2 : 1 });
  }
  return scored.sort((a, b) => b.score - a.score || a.url.href.localeCompare(b.url.href)).slice(0, Math.max(0, limit)).map(item => item.url);
}

export async function discoverWebsiteContacts({ website, fetchText = safeFetchText, timeoutMs = 5000, maxBytes = 524288, maxPages = 4 }) {
  const root = normalizeWebsiteUrl(website);
  if (!root) return { status: 'blocked', reason: 'invalid_or_unsafe_website', pagesVisited: 0, candidates: [] };
  const options = { timeoutMs, maxBytes };
  let robots = '';
  try {
    const robotsResult = await fetchText(new URL('/robots.txt', root), options);
    if (robotsResult.status === 200) robots = robotsResult.body;
    else if (robotsResult.status === 401 || robotsResult.status === 403) return { status: 'blocked', reason: 'robots_access_denied', pagesVisited: 0, candidates: [] };
    else if (robotsResult.status >= 500) return { status: 'failed', reason: 'robots_temporarily_unavailable', pagesVisited: 0, candidates: [] };
  } catch (error) {
    return { status: 'failed', reason: `robots_check_failed:${error.message}`, pagesVisited: 0, candidates: [] };
  }
  if (robots && !robotsAllows(robots, root.pathname || '/')) return { status: 'blocked', reason: 'robots_disallow', pagesVisited: 0, candidates: [] };

  let home;
  try { home = await fetchText(root, options); } catch (error) {
    return { status: 'failed', reason: `website_fetch_failed:${error.message}`, pagesVisited: 0, candidates: [] };
  }
  if (home.status < 200 || home.status >= 300) return { status: 'failed', reason: `website_http_${home.status}`, pagesVisited: 0, candidates: [] };
  const homeUrl = new URL(home.url || root.href);
  const pages = [{ url: homeUrl, body: home.body }];
  for (const url of extractContactPageLinks(home.body, homeUrl, Math.max(0, maxPages - 1))) {
    if (pages.length >= maxPages) break;
    if (robots && !robotsAllows(robots, url.pathname || '/')) continue;
    try {
      const result = await fetchText(url, options);
      if (result.status >= 200 && result.status < 300) pages.push({ url: new URL(result.url || url.href), body: result.body });
    } catch { /* best-effort enrichment keeps already collected public evidence */ }
  }
  const candidates = [];
  const seen = new Set();
  for (const page of pages) {
    for (const candidate of extractWebsitePhoneCandidates(page.body, page.url.href)) {
      if (seen.has(candidate.destination)) continue;
      seen.add(candidate.destination);
      candidates.push(candidate);
    }
  }
  return {
    status: candidates.length ? 'succeeded' : 'no_candidates',
    reason: candidates.length ? null : 'no_public_phone_found',
    website: root.href,
    finalUrl: homeUrl.href,
    pagesVisited: pages.length,
    candidates
  };
}

function retryAt(status) {
  const hours = status === 'succeeded' ? 24 * 30 : status === 'blocked' || status === 'no_website' ? 24 * 30 : status === 'no_candidates' ? 24 * 7 : 6;
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

export async function seedWebsiteRecipientContacts(repository, t3010Repository, organizationId, {
  enabled = false,
  timeoutMs = 5000,
  maxBytes = 524288,
  maxPages = 4,
  discoverer = discoverWebsiteContacts
} = {}) {
  if (!enabled) return { skipped: true, reason: 'website_enrichment_disabled' };
  if (!t3010Repository?.loaded) return { skipped: true, reason: 't3010_not_loaded' };
  const organization = await repository.getOrganization(organizationId);
  if (!organization?.business_number) return { skipped: true, reason: 'organization_has_no_bn' };
  const profile = t3010Repository.charityProfile(organization.business_number);
  const website = profile?.website || '';
  const client = await repository.pool.connect();
  try {
    const locked = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`website-contact:${organizationId}`]);
    if (!locked.rows[0]?.locked) return { skipped: true, reason: 'discovery_in_progress' };
    const previous = (await client.query('SELECT * FROM recipient_contact_discovery WHERE organization_id=$1', [organizationId])).rows[0];
    if (previous?.next_attempt_at && new Date(previous.next_attempt_at).getTime() > Date.now()) {
      return { skipped: true, reason: 'discovery_backoff', nextAttemptAt: previous.next_attempt_at };
    }
    if (!website) {
      await client.query(`
        INSERT INTO recipient_contact_discovery (organization_id,status,attempts,last_attempt_at,next_attempt_at,last_error)
        VALUES ($1,'no_website',1,now(),$2,'T3010 profile has no public website')
        ON CONFLICT (organization_id) DO UPDATE SET status='no_website',attempts=recipient_contact_discovery.attempts+1,last_attempt_at=now(),next_attempt_at=$2,last_error='T3010 profile has no public website',updated_at=now()
      `, [organizationId, retryAt('no_website')]);
      return { status: 'no_website', insertedContacts: 0, candidatesFound: 0 };
    }
    const result = await discoverer({ website, timeoutMs, maxBytes, maxPages });
    let inserted = 0;
    for (const candidate of result.candidates || []) {
      const stored = await upsertRecipientContactCandidate(repository, {
        organizationId,
        channel: candidate.channel,
        destination: candidate.destination,
        source: 'website_public',
        sourceEvidence: { website, pageUrl: candidate.sourceUrl, extraction: candidate.extraction, discoveredAt: new Date().toISOString() }
      });
      if (stored.inserted) inserted += 1;
    }
    await client.query(`
      INSERT INTO recipient_contact_discovery
        (organization_id,website_url,status,attempts,pages_visited,candidates_found,inserted_contacts,last_attempt_at,next_attempt_at,last_error,evidence)
      VALUES ($1,$2,$3,1,$4,$5,$6,now(),$7,$8,$9::jsonb)
      ON CONFLICT (organization_id) DO UPDATE SET
        website_url=EXCLUDED.website_url,status=EXCLUDED.status,attempts=recipient_contact_discovery.attempts+1,
        pages_visited=EXCLUDED.pages_visited,candidates_found=EXCLUDED.candidates_found,inserted_contacts=EXCLUDED.inserted_contacts,
        last_attempt_at=now(),next_attempt_at=EXCLUDED.next_attempt_at,last_error=EXCLUDED.last_error,evidence=EXCLUDED.evidence,updated_at=now()
    `, [organizationId, website, result.status, result.pagesVisited || 0, result.candidates?.length || 0, inserted,
      retryAt(result.status), result.reason || null, JSON.stringify({ finalUrl: result.finalUrl || null })]);
    return { ...result, insertedContacts: inserted, candidatesFound: result.candidates?.length || 0 };
  } catch (error) {
    try {
      await client.query(`
        INSERT INTO recipient_contact_discovery (organization_id,website_url,status,attempts,last_attempt_at,next_attempt_at,last_error)
        VALUES ($1,$2,'failed',1,now(),$3,$4)
        ON CONFLICT (organization_id) DO UPDATE SET website_url=EXCLUDED.website_url,status='failed',attempts=recipient_contact_discovery.attempts+1,last_attempt_at=now(),next_attempt_at=$3,last_error=$4,updated_at=now()
      `, [organizationId, website || null, retryAt('failed'), String(error.message).slice(0, 2000)]);
    } catch { /* preserve original discovery error */ }
    return { status: 'failed', reason: error.message, insertedContacts: 0, candidatesFound: 0 };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`website-contact:${organizationId}`]).catch(() => {});
    client.release();
  }
}
