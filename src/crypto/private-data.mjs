import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyFromSecret(secret) {
  if (!secret) throw new Error('ENCRYPTION_KEY is required for private workflow data.');
  return createHash('sha256').update(String(secret)).digest();
}

export function encryptPrivateJson(value, secret = process.env.ENCRYPTION_KEY) {
  const key = keyFromSecret(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

export function decryptPrivateJson(envelope, secret = process.env.ENCRYPTION_KEY) {
  if (!envelope || Object.keys(envelope).length === 0) return {};
  if (envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new Error('Unsupported private-profile encryption envelope.');
  const key = keyFromSecret(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
