export class DisabledNotificationAdapter {
  async send() {
    return { delivered: false, status: 'disabled', providerMessageId: null };
  }
}

export class ConsoleNotificationAdapter {
  constructor({ logger = console } = {}) { this.logger = logger; }
  async send(message) {
    if (!message?.recipient || !message?.body) throw new Error('Notification recipient and body are required.');
    this.logger.info?.('[notification:console]', { recipient: message.recipient, channel: message.channel || 'unknown' });
    return { delivered: true, status: 'simulated', providerMessageId: `console-${Date.now()}` };
  }
}
