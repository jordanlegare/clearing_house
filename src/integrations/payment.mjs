export class DisabledPaymentAdapter {
  async authorize() {
    return { authorized: false, status: 'disabled', paymentIntentId: null };
  }
  async recordExternalPayment() {
    throw new Error('Payment adapter is disabled.');
  }
}

export class ManualPaymentAdapter {
  async authorize({ grantId, amountCad }) {
    if (!grantId || !Number.isFinite(amountCad) || amountCad <= 0) throw new Error('Valid grantId and amountCad are required.');
    return { authorized: true, status: 'manual_external_execution_required', paymentIntentId: `manual:${grantId}` };
  }
  async recordExternalPayment({ grantId, externalPaymentReference }) {
    if (!grantId || !String(externalPaymentReference || '').trim()) throw new Error('External payment reference is required.');
    return { recorded: true, grantId, externalPaymentReference, moneyMovedByThisAdapter: false };
  }
}
