function xmlEscape(value) {
  return String(value).replace(/[<>&'\"]/g, ch => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[ch]));
}

const DELIVERY_FAILURE_MESSAGES = Object.freeze({
  EMAIL_PROVIDER_DISABLED: 'Email notification provider is disabled.',
  PHONE_PROVIDER_DISABLED: 'Phone notification provider is disabled.',
  UNSUPPORTED_NOTIFICATION_CHANNEL: 'Unsupported notification channel.',
  UNSUPPORTED_EMAIL_PROVIDER: 'Unsupported email notification provider.',
  UNSUPPORTED_PHONE_PROVIDER: 'Unsupported phone notification provider.',
  TWILIO_REQUEST_FAILED: 'Twilio notification delivery failed.',
  RESEND_REQUEST_FAILED: 'Resend notification delivery failed.'
});

export class NotificationDeliveryError extends Error {
  constructor(code, { httpStatus = null } = {}) {
    const summary = DELIVERY_FAILURE_MESSAGES[code] || 'Notification delivery failed.';
    const status = Number.isInteger(Number(httpStatus)) && Number(httpStatus) >= 100 && Number(httpStatus) <= 599
      ? ` HTTP ${Number(httpStatus)}.`
      : '';
    super(status ? `${summary.slice(0, -1)};${status}` : summary);
    this.name = 'NotificationDeliveryError';
    this.code = DELIVERY_FAILURE_MESSAGES[code] ? code : 'NOTIFICATION_DELIVERY_FAILED';
  }
}

export function notificationDeliveryFailureSummary(error) {
  return error instanceof NotificationDeliveryError ? error.message : 'Notification delivery failed.';
}

async function twilioPost(config, resource, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/${resource}.json`;
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new NotificationDeliveryError('TWILIO_REQUEST_FAILED', { httpStatus: response.status });
  return { providerMessageId: payload.sid || null, providerStatus: payload.status || null };
}

async function resendPost(config, { to, subject, body, idempotencyKey }) {
  const headers = {
    authorization: `Bearer ${config.resendApiKey}`,
    'content-type': 'application/json',
    'user-agent': 'CanadianPhilanthropyClearingHouse/1.0'
  };
  if (idempotencyKey) headers['idempotency-key'] = String(idempotencyKey).slice(0, 256);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: config.resendFromEmail,
      to: [to],
      subject: subject || 'Canadian Philanthropy Clearing House',
      text: body
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new NotificationDeliveryError('RESEND_REQUEST_FAILED', { httpStatus: response.status });
  return { providerMessageId: payload.id || null, providerStatus: 'accepted' };
}

export function createNotificationProvider(config) {
  return {
    async send({ channel, to, body, subject = null, idempotencyKey = null }) {
      if (channel === 'email') {
        if (config.emailProvider === 'disabled') throw new NotificationDeliveryError('EMAIL_PROVIDER_DISABLED');
        if (config.emailProvider === 'console') {
          console.log('[notification]', { channel, to: '[redacted]', subject, body });
          return { providerMessageId: `console-email-${Date.now()}` };
        }
        if (config.emailProvider === 'resend') return resendPost(config, { to, subject, body, idempotencyKey });
        throw new NotificationDeliveryError('UNSUPPORTED_EMAIL_PROVIDER');
      }

      if (!['sms','voice'].includes(channel)) throw new NotificationDeliveryError('UNSUPPORTED_NOTIFICATION_CHANNEL');
      if (config.notificationProvider === 'disabled') throw new NotificationDeliveryError('PHONE_PROVIDER_DISABLED');
      if (config.notificationProvider === 'console') {
        console.log('[notification]', { channel, to: '[redacted]', body });
        return { providerMessageId: `console-${Date.now()}` };
      }
      if (config.notificationProvider === 'twilio') {
        if (channel === 'sms') return twilioPost(config, 'Messages', { To: to, From: config.twilioFromNumber, Body: body });
        const twiml = `<Response><Say>${xmlEscape(body)}</Say></Response>`;
        return twilioPost(config, 'Calls', { To: to, From: config.twilioFromNumber, Twiml: twiml });
      }
      throw new NotificationDeliveryError('UNSUPPORTED_PHONE_PROVIDER');
    }
  };
}
