import crypto from 'node:crypto';

function keyBytes(secret) {
  if (!secret || secret.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters.');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptText(plaintext, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptText(encoded, secret) {
  if (!String(encoded).startsWith('enc:v1:')) throw new Error('Unsupported encrypted value format.');
  const [iv64, tag64, data64] = String(encoded).slice(7).split('.');
  if (!iv64 || !tag64 || data64 === undefined) throw new Error('Malformed encrypted value.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(secret), Buffer.from(iv64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64url')), decipher.final()]).toString('utf8');
}
