import {
  extractContactPageLinks,
  normalizeWebsiteUrl,
  robotsAllows,
  safeFetchText
} from './website_contact.mjs';
import { normalizeEmail } from '../t3010/normalize.mjs';
import { upsertRecipientContactCandidate } from '../workflow/recipient_contacts.mjs';

function stripMarkup(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/\s+/g, ' ');
}

function addCandidate(out, seen, raw, sourceUrl, extraction) {
  const email = normalizeEmail(raw);
  if (!email || seen.has(email)) return;
  seen.add(email);
  out.push({ channel: 'email', destination: email, sourceUrl, extraction });
}

export function extractWebsiteEmailCandidates(html, sourceUrl) {
  const out = [];
  const seen = new Set();
  const source = String(html || '');
  for (const match of source.matchAll(/href\s*=\s*["']mailto:([^"']+)["']/gi)) {
    const value = match[1].split('?')[0];
    addCandidate(out, seen, value, sourceUrl, 'mailto_link');
  }
  const text = stripMarkup(source);
  const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/ig;
  for (const match of text.matchAll(emailPattern)) addCandidate(out, seen, match[0], sourceUrl, 'page_text');
  return out;
}

export async function discoverWebsiteEmailContacts({ website, fetchText = safeFetchText, timeoutMs = 5000, maxBytes = 524288, maxPages = 4 }) {
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
    } catch { /* preserve already-collected public evidence */ }
  }

  const candidates = [];
  const seen = new Set();
  for (const page of pages) {
    for (const candidate of extractWebsiteEmailCandidates(page.body, page.url.href)) {
      if (seen.has(candidate.destination)) continue;
      seen.add(candidate.destination);
      candidates.push(candidate);
    }
  }
  return {
    status: candidates.length ? 'succeeded' : 'no_candidates',
    reason: candidates.length ? null : 'no_public_email_found',
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

export async function seedWebsiteRecipientEmailContacts(repository, t3010Repository, organizationId, {
  enabled = false,
  timeoutMs = 5000,
  maxBytes = 524288,
  maxPages = 4,
  discoverer = discoverWebsiteEmailContacts
} = {}) {
  if (!enabled) return { skipped: true, reason: 'website_enrichment_disabled' };
  if (!t3010Repository?.loaded) return { skipped: true, reason: 't3010_not_loaded' };
  const organization = await repository.getOrganization(organizationId);
  if (!organization?.business_number) return { skipped: true, reason: 'organization_has_no_bn' };
  const profile = t3010Repository.charityProfile(organization.business_number);
  const website = profile?.website || '';
  const client = await repository.pool.connect();
  const lockKey = `website-email-contact:${organizationId}`;
  try {
    const locked = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockKey]);
    if (!locked.rows[0]?.locked) return { skipped: true, reason: 'discovery_in_progress' };
    const previous = (await client.query(`
      SELECT * FROM recipient_contact_channel_discovery
      WHERE organization_id=$1 AND channel='email' AND source='website_public'
    `, [organizationId])).rows[0];
    if (previous?.next_attempt_at && new Date(previous.next_attempt_at).getTime() > Date.now()) {
      return { skipped: true, reason: 'discovery_backoff', nextAttemptAt: previous.next_attempt_at };
    }
    if (!website) {
      await client.query(`
        INSERT INTO recipient_contact_channel_discovery
          (organization_id,channel,source,status,attempts,last_attempt_at,next_attempt_at,last_error)
        VALUES ($1,'email','website_public','no_website',1,now(),$2,'T3010 profile has no public website')
        ON CONFLICT (organization_id,channel,source) DO UPDATE SET
          status='no_website',attempts=recipient_contact_channel_discovery.attempts+1,last_attempt_at=now(),next_attempt_at=$2,
          last_error='T3010 profile has no public website',updated_at=now()
      `, [organizationId, retryAt('no_website')]);
      return { status: 'no_website', insertedContacts: 0, candidatesFound: 0 };
    }

    const result = await discoverer({ website, timeoutMs, maxBytes, maxPages });
    let inserted = 0;
    for (const candidate of result.candidates || []) {
      const stored = await upsertRecipientContactCandidate(repository, {
        organizationId,
        channel: 'email',
        destination: candidate.destination,
        source: 'website_public',
        sourceEvidence: {
          website,
          pageUrl: candidate.sourceUrl,
          extraction: candidate.extraction,
          discoveredAt: new Date().toISOString()
        }
      });
      if (stored.inserted) inserted += 1;
    }
    await client.query(`
      INSERT INTO recipient_contact_channel_discovery
        (organization_id,channel,source,status,attempts,pages_visited,candidates_found,inserted_contacts,last_attempt_at,next_attempt_at,last_error,evidence)
      VALUES ($1,'email','website_public',$2,1,$3,$4,$5,now(),$6,$7,$8::jsonb)
      ON CONFLICT (organization_id,channel,source) DO UPDATE SET
        status=EXCLUDED.status,attempts=recipient_contact_channel_discovery.attempts+1,pages_visited=EXCLUDED.pages_visited,
        candidates_found=EXCLUDED.candidates_found,inserted_contacts=EXCLUDED.inserted_contacts,last_attempt_at=now(),
        next_attempt_at=EXCLUDED.next_attempt_at,last_error=EXCLUDED.last_error,evidence=EXCLUDED.evidence,updated_at=now()
    `, [organizationId, result.status, result.pagesVisited || 0, result.candidates?.length || 0, inserted,
      retryAt(result.status), result.reason || null, JSON.stringify({ website, finalUrl: result.finalUrl || null })]);
    return { ...result, insertedContacts: inserted, candidatesFound: result.candidates?.length || 0 };
  } catch (error) {
    try {
      await client.query(`
        INSERT INTO recipient_contact_channel_discovery
          (organization_id,channel,source,status,attempts,last_attempt_at,next_attempt_at,last_error,evidence)
        VALUES ($1,'email','website_public','failed',1,now(),$2,$3,$4::jsonb)
        ON CONFLICT (organization_id,channel,source) DO UPDATE SET
          status='failed',attempts=recipient_contact_channel_discovery.attempts+1,last_attempt_at=now(),next_attempt_at=$2,
          last_error=$3,evidence=EXCLUDED.evidence,updated_at=now()
      `, [organizationId, retryAt('failed'), String(error.message).slice(0, 2000), JSON.stringify({ website: website || null })]);
    } catch { /* preserve original discovery error */ }
    return { status: 'failed', reason: error.message, insertedContacts: 0, candidatesFound: 0 };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    client.release();
  }
}
