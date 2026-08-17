import crypto from 'node:crypto';
import { normalizeContactDestination } from './recipient_contacts.mjs';

export const TEST_NOTIFICATION_PREFIX = 'Clearing House delivery test — no grant action is required.';

export function maskTestDestination(channel, destination) {
  if (channel === 'email') {
    const [local, domain] = destination.split('@');
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${'•'.repeat(Math.min(Math.max(local.length - visible.length, 2), 8))}@${domain}`;
  }
  return `•••-•••-${destination.replace(/\D/g, '').slice(-4)}`;
}

export function prepareTestNotification({ channel, destination, subject = '', message, confirmation }) {
  if (!['email', 'sms', 'voice'].includes(channel)) throw new Error('Test notification channel must be email, sms, or voice.');
  const normalizedDestination = normalizeContactDestination(channel, destination);
  const normalizedSubject = String(subject || '').trim();
  const normalizedMessage = String(message || '').trim();
  if (!normalizedMessage) throw new Error('Test notification message is required.');
  if (normalizedMessage.length > 500) throw new Error('Test notification message cannot exceed 500 characters.');
  if (normalizedSubject.length > 120) throw new Error('Test notification subject cannot exceed 120 characters.');
  if (channel !== 'email' && normalizedSubject) throw new Error('A subject is supported only for email test notifications.');
  const expected = `SEND TEST ${channel.toUpperCase()} TO ${normalizedDestination}`;
  if (confirmation !== expected) throw new Error(`Exact confirmation required for ${channel} test notification.`);
  const requestDigest = crypto.createHash('sha256').update(JSON.stringify({
    channel,
    destination: normalizedDestination,
    subject: normalizedSubject,
    message: normalizedMessage
  })).digest('hex');
  return {
    channel,
    destination: normalizedDestination,
    maskedDestination: maskTestDestination(channel, normalizedDestination),
    subject: normalizedSubject,
    message: `${TEST_NOTIFICATION_PREFIX}\n\n${normalizedMessage}`,
    requestDigest
  };
}
