import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwksCache = new Map();

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || null;
}

async function jwksForIssuer(issuer) {
  if (!jwksCache.has(issuer)) {
    jwksCache.set(issuer, (async () => {
      const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
      const response = await fetch(`${base}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}.`);
      const discovery = await response.json();
      if (discovery.issuer && discovery.issuer !== issuer) throw new Error('OIDC discovery issuer mismatch.');
      if (!discovery.jwks_uri) throw new Error('OIDC discovery document is missing jwks_uri.');
      return createRemoteJWKSet(new URL(discovery.jwks_uri));
    })());
  }
  return jwksCache.get(issuer);
}

export async function verifyBearerClaims(req, config) {
  const token = bearerToken(req);
  if (!token) return null;
  if (!config.oidcIssuer) throw new Error('OIDC issuer is not configured.');

  const options = { issuer: config.oidcIssuer };
  if (config.oidcAudience) options.audience = config.oidcAudience;
  const jwks = await jwksForIssuer(config.oidcIssuer);
  const { payload } = await jwtVerify(token, jwks, options);
  if (!payload.sub) throw new Error('Authenticated token is missing sub.');
  return payload;
}

export async function authenticateRequest(req, config, workflowRepository) {
  const claims = await verifyBearerClaims(req, config);
  if (!claims) return null;
  if (!workflowRepository) throw new Error('Workflow database is not configured.');
  return workflowRepository.upsertActorFromClaims({
    subject: String(claims.sub),
    email: typeof claims.email === 'string' ? claims.email : null,
    displayName: typeof claims.name === 'string' ? claims.name : null,
    scopes: typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : []
  });
}
