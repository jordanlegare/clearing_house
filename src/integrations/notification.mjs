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

export function createNotificationProvider(config) {
  if (config.notificationProvider === 'disabled') {
    return { async send() { throw new Error('Notification provider is disabled.'); } };
  }
  if (config.notificationProvider === 'console') {
    return { async send(message) { console.log('[notification]', { ...message, to: '[redacted]' }); return { providerMessageId: `console-${Date.now()}` }; } };
  }
  if (config.notificationProvider === 'twilio') {
    return {
      async send({ channel, to, body }) {
        if (channel === 'sms') return twilioPost(config, 'Messages', { To: to, From: config.twilioFromNumber, Body: body });
        if (channel === 'voice') {
          const twiml = `<Response><Say>${xmlEscape(body)}</Say></Response>`;
          return twilioPost(config, 'Calls', { To: to, From: config.twilioFromNumber, Twiml: twiml });
        }
        throw new Error(`Twilio provider does not support channel ${channel}.`);
      }
    };
  }
  throw new Error(`Unsupported notification provider: ${config.notificationProvider}`);
}
