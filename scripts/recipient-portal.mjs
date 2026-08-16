import http from 'node:http';
import { createDatabasePool } from '../src/db/pool.mjs';
import { WorkflowRepository } from '../src/db/workflow_repository.mjs';
import { loadRuntimeConfig, assessReadiness } from '../src/config/requirements.mjs';
import { inspectOfferAccess, consumeOfferAccess, OfferAccessError } from '../src/workflow/offer_access.mjs';

const config = loadRuntimeConfig();
const readiness = assessReadiness(config);
if (!readiness.ready) throw new Error(`Recipient portal readiness failed: ${readiness.blockers.join(' ')}`);
if (!config.recipientPortalEnabled) throw new Error('RECIPIENT_PORTAL_ENABLED must be enabled to run the recipient portal.');
if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the recipient portal.');
if (!config.auditHmacKey || config.auditHmacKey.length < 32) throw new Error('AUDIT_HMAC_KEY is required for recipient offer audit records.');

const pool = createDatabasePool(config.databaseUrl);
const repository = new WorkflowRepository(pool, { auditHmacKey: config.auditHmacKey, encryptionKey: config.encryptionKey });
const port = config.recipientPortalPort;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

function money(value) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(Number(value));
}

function securityHeaders(extra = {}) {
  return {
    'cache-control': 'no-store, max-age=0',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra
  };
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f6f7f8}body{margin:0}.wrap{max-width:760px;margin:0 auto;padding:32px 18px 64px}.card{background:white;border:1px solid #ddd;border-radius:14px;padding:26px;box-shadow:0 1px 4px rgba(0,0,0,.05)}h1{font-size:1.65rem;margin:.2rem 0 1rem}.eyebrow{font-size:.82rem;text-transform:uppercase;letter-spacing:.08em;color:#5d6470}.amount{font-size:2rem;font-weight:700;margin:.6rem 0}.meta{color:#4d535d}.terms{white-space:pre-wrap;background:#f7f7f8;border:1px solid #e4e4e7;border-radius:10px;padding:16px;max-height:360px;overflow:auto}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}.actions form{margin:0}button{font:inherit;border-radius:9px;padding:11px 18px;border:1px solid #222;cursor:pointer}.accept{background:#111;color:white}.decline{background:white;color:#222}.notice{padding:12px 14px;background:#f2f4f7;border-radius:9px;margin:18px 0}.small{font-size:.9rem;color:#606773}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function sendHtml(res, statusCode, title, body) {
  res.writeHead(statusCode, securityHeaders({ 'content-type': 'text/html; charset=utf-8' }));
  res.end(layout(title, body));
}

function invalidPage(res) {
  sendHtml(res, 410, 'Funding offer unavailable', `<div class="card"><div class="eyebrow">Canadian Philanthropy Clearing House</div><h1>This funding-offer link is no longer available.</h1><p>It may have expired, already been used, or been replaced by a newer offer link.</p><p class="small">Contact the funding organization if you believe you still have an active offer.</p></div>`);
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Request body too large.');
  }
  return new URLSearchParams(body);
}

function offerPage(offer, token) {
  const expires = offer.expiresAt ? new Date(offer.expiresAt).toLocaleString('en-CA', { timeZoneName: 'short' }) : 'soon';
  const encoded = encodeURIComponent(token);
  return `<div class="card">
    <div class="eyebrow">No application required</div>
    <h1>${escapeHtml(offer.recipient.name)}, you have a funding offer.</h1>
    <div class="amount">${escapeHtml(money(offer.amountCad))}</div>
    <p class="meta">From <strong>${escapeHtml(offer.foundation.name)}</strong></p>
    <h2>Purpose</h2><p>${escapeHtml(offer.purpose)}</p>
    <h2>Terms</h2><div class="terms">${escapeHtml(offer.termsText || '')}</div>
    <div class="notice">Accepting records your organization's consent to terms version <strong>${escapeHtml(offer.termsVersion)}</strong>. It does not require a grant application and it does not by itself move money.</div>
    <div class="actions">
      <form method="post" action="/offer/${encoded}/accept"><input type="hidden" name="confirm" value="accept"><button class="accept" type="submit">Accept funding offer</button></form>
      <form method="post" action="/offer/${encoded}/decline"><input type="hidden" name="confirm" value="decline"><button class="decline" type="submit">Decline</button></form>
    </div>
    <p class="small">Secure link expires ${escapeHtml(expires)}. Do not forward this link; possession of it authorizes one response on behalf of the recipient organization.</p>
  </div>`;
}

function resultPage(result) {
  const accepted = result.action === 'accept';
  return `<div class="card"><div class="eyebrow">Canadian Philanthropy Clearing House</div>
    <h1>${accepted ? 'Funding offer accepted.' : 'Funding offer declined.'}</h1>
    <p>${escapeHtml(result.recipient.name)} ${accepted ? 'accepted' : 'declined'} the ${escapeHtml(money(result.amountCad))} offer from ${escapeHtml(result.foundation.name)}.</p>
    ${accepted ? '<div class="notice">No further grant application is required. The foundation must still complete any remaining compliance and payment steps.</div>' : ''}
    <p class="small">This secure link has now been consumed and cannot be used again.</p></div>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://recipient-portal.local');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, securityHeaders({ 'content-type': 'application/json' }));
      return res.end(JSON.stringify({ ok: true, service: 'recipient-portal' }));
    }

    const getMatch = url.pathname.match(/^\/offer\/([A-Za-z0-9_-]{40,128})$/);
    if (req.method === 'GET' && getMatch) {
      try {
        const offer = await inspectOfferAccess(repository, getMatch[1]);
        return sendHtml(res, 200, 'Review funding offer', offerPage(offer, getMatch[1]));
      } catch (error) {
        if (error instanceof OfferAccessError) return invalidPage(res);
        throw error;
      }
    }

    const actionMatch = url.pathname.match(/^\/offer\/([A-Za-z0-9_-]{40,128})\/(accept|decline)$/);
    if (req.method === 'POST' && actionMatch) {
      const [, token, action] = actionMatch;
      const form = await readForm(req);
      if (form.get('confirm') !== action) return invalidPage(res);
      try {
        const result = await consumeOfferAccess(repository, token, action);
        return sendHtml(res, 200, acceptedTitle(action), resultPage(result));
      } catch (error) {
        if (error instanceof OfferAccessError) return invalidPage(res);
        throw error;
      }
    }

    res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    res.end('Not found');
  } catch (error) {
    console.error('[recipient-portal] request failed:', error.message);
    sendHtml(res, 500, 'Temporary error', `<div class="card"><h1>We could not process this request.</h1><p>Please try again later or contact the funding organization.</p></div>`);
  }
});

function acceptedTitle(action) {
  return action === 'accept' ? 'Funding offer accepted' : 'Funding offer declined';
}

server.listen(port, () => console.log(`Recipient funding-offer portal listening on :${port}`));

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down recipient portal.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => shutdown(signal));
