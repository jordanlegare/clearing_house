function xmlEscape(value) {
  return String(value).replace(/[<>&'\"]/g, ch => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[ch]));
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
  if (!response.ok) throw new Error(`Twilio ${resource} failed with HTTP ${response.status}: ${payload.message || 'unknown error'}`);
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
  if (!response.ok) throw new Error(`Resend email failed with HTTP ${response.status}: ${payload.message || payload.name || 'unknown error'}`);
  return { providerMessageId: payload.id || null, providerStatus: 'accepted' };
}

export function createNotificationProvider(config) {
  return {
    async send({ channel, to, body, subject = null, idempotencyKey = null }) {
      if (channel === 'email') {
        if (config.emailProvider === 'disabled') throw new Error('Email notification provider is disabled.');
        if (config.emailProvider === 'console') {
          console.log('[notification]', { channel, to: '[redacted]', subject, body });
          return { providerMessageId: `console-email-${Date.now()}` };
        }
        if (config.emailProvider === 'resend') return resendPost(config, { to, subject, body, idempotencyKey });
        throw new Error(`Unsupported email provider: ${config.emailProvider}.`);
      }

      if (!['sms','voice'].includes(channel)) throw new Error(`Unsupported notification channel: ${channel}.`);
      if (config.notificationProvider === 'disabled') throw new Error('Phone notification provider is disabled.');
      if (config.notificationProvider === 'console') {
        console.log('[notification]', { channel, to: '[redacted]', body });
        return { providerMessageId: `console-${Date.now()}` };
      }
      if (config.notificationProvider === 'twilio') {
        if (channel === 'sms') return twilioPost(config, 'Messages', { To: to, From: config.twilioFromNumber, Body: body });
        const twiml = `<Response><Say>${xmlEscape(body)}</Say></Response>`;
        return twilioPost(config, 'Calls', { To: to, From: config.twilioFromNumber, Twiml: twiml });
      }
      throw new Error(`Unsupported notification provider: ${config.notificationProvider}`);
    }
  };
}
