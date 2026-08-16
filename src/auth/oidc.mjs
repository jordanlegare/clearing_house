import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { ROLES } from '../security/rbac.mjs';

const VALID_ROLES = new Set(Object.values(ROLES));
const cache = new Map();
function b64url(value) { const pad = value.length % 4 ? '='.repeat(4 - value.length % 4) : ''; return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64'); }
function decodeJson(value) { return JSON.parse(b64url(value).toString('utf8')); }
function normalizeBn(value) { return String(value || '').toUpperCase().replace(/[\s-]/g, ''); }
function rolesFromClaims(payload) { const raw=payload.roles??payload.role??[]; const candidates=new Set((Array.isArray(raw)?raw:[raw]).filter(Boolean).map(String)); for(const scope of String(payload.scope||'').split(/\s+/)) if(scope.startsWith('role:')) candidates.add(scope.slice(5)); return [...candidates].filter(role=>VALID_ROLES.has(role)); }
function orgsFromClaims(payload) { const raw=payload.org_bns??payload.organization_bns??payload.orgBn??[]; return [...new Set((Array.isArray(raw)?raw:[raw]).filter(Boolean).map(normalizeBn))]; }
async function discovery(issuer) { const key=`discovery:${issuer}`; const hit=cache.get(key); if(hit&&hit.expires>Date.now()) return hit.value; const response=await fetch(`${issuer.replace(/\/$/,'')}/.well-known/openid-configuration`,{headers:{accept:'application/json'}}); if(!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`); const value=await response.json(); cache.set(key,{value,expires:Date.now()+5*60_000}); return value; }
async function jwkFor(jwksUrl,kid) { const key=`jwks:${jwksUrl}`; let hit=cache.get(key); if(!hit||hit.expires<=Date.now()){const response=await fetch(jwksUrl,{headers:{accept:'application/json'}});if(!response.ok)throw new Error(`JWKS fetch failed: ${response.status}`);hit={value:await response.json(),expires:Date.now()+5*60_000};cache.set(key,hit);}const jwk=hit.value.keys?.find(candidate=>candidate.kid===kid);if(!jwk)throw new Error(`No JWKS key found for kid ${kid}.`);return jwk; }
function validateClaims(payload,{issuer,audience}) { const now=Math.floor(Date.now()/1000); if(!payload.sub)throw new Error('JWT subject is required.'); if(payload.exp&&now>=payload.exp)throw new Error('JWT is expired.'); if(payload.nbf&&now<payload.nbf)throw new Error('JWT is not active yet.'); if(issuer&&payload.iss!==issuer)throw new Error('Unexpected JWT issuer.'); if(audience){const actual=Array.isArray(payload.aud)?payload.aud:[payload.aud];if(!actual.includes(audience))throw new Error('Unexpected JWT audience.');} }
export async function authenticateBearer(req,config) {
  const header=String(req.headers.authorization||''); if(!header.startsWith('Bearer ')) return null;
  const token=header.slice(7).trim(); const [h,p,s]=token.split('.'); if(!h||!p||!s)throw Object.assign(new Error('Malformed bearer token.'),{statusCode:401});
  try {
    const protectedHeader=decodeJson(h),payload=decodeJson(p),signed=Buffer.from(`${h}.${p}`),signature=b64url(s); const issuer=config.oidcIssuer||'',audience=config.oidcAudience||config.oidcClientId||''; validateClaims(payload,{issuer,audience});
    if(protectedHeader.alg==='HS256'&&process.env.ALLOW_DEV_AUTH==='1'&&config.nodeEnv!=='production'){const secret=process.env.DEV_AUTH_SECRET;if(!secret)throw new Error('DEV_AUTH_SECRET is required for development authentication.');const expected=createHmac('sha256',secret).update(signed).digest();if(expected.length!==signature.length||!timingSafeEqual(expected,signature))throw new Error('Invalid JWT signature.');}
    else if(protectedHeader.alg==='RS256'){const jwksUrl=config.oidcJwksUrl||(await discovery(issuer)).jwks_uri;if(!jwksUrl)throw new Error('OIDC provider did not publish a jwks_uri.');const jwk=await jwkFor(jwksUrl,protectedHeader.kid);const key=createPublicKey({key:jwk,format:'jwk'});if(!verifySignature('RSA-SHA256',signed,key,signature))throw new Error('Invalid JWT signature.');}
    else throw new Error(`Unsupported JWT algorithm ${protectedHeader.alg}.`);
    return {sub:String(payload.sub),email:String(payload.email||''),name:String(payload.name||payload.preferred_username||''),roles:rolesFromClaims(payload),organizationBns:orgsFromClaims(payload),claims:payload};
  } catch(error){throw Object.assign(error,{statusCode:401});}
}
export function makeDevToken(payload,secret=process.env.DEV_AUTH_SECRET||'test-secret'){const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const p=Buffer.from(JSON.stringify(payload)).toString('base64url');const s=createHmac('sha256',secret).update(`${h}.${p}`).digest('base64url');return `${h}.${p}.${s}`;}
