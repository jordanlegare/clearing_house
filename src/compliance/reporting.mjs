export const RECIPIENT_TYPES = Object.freeze({
  QUALIFIED_DONEE: 'qualified_donee',
  NON_QUALIFIED_DONEE: 'non_qualified_donee'
});

export function aggregateGrantsByRecipient(grants = []) {
  const totals = new Map();
  for (const grant of grants) {
    if (!grant.recipientOrgId) throw new Error('recipientOrgId is required');
    const amount = Number(grant.amountCad);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('amountCad must be non-negative');
    totals.set(grant.recipientOrgId, (totals.get(grant.recipientOrgId) || 0) + amount);
  }
  return totals;
}

export function classifyGrantReporting({ recipientType, recipientOrgId, fiscalYearGrants = [], thresholdCad = 5000 }) {
  if (!Object.values(RECIPIENT_TYPES).includes(recipientType)) throw new Error(`Unknown recipient type: ${recipientType}`);
  const totals = aggregateGrantsByRecipient(fiscalYearGrants);
  const aggregateCad = totals.get(recipientOrgId) || 0;

  if (recipientType === RECIPIENT_TYPES.QUALIFIED_DONEE) {
    return {
      recipientType,
      aggregateCad,
      route: 'qualified_donee_reporting',
      t1441Required: false,
      note: 'Prepare the applicable T3010/qualified-donee reporting record; exact form fields must be versioned to the current CRA filing package.'
    };
  }

  return {
    recipientType,
    aggregateCad,
    route: aggregateCad > thresholdCad ? 't1441_individual_grant_reporting' : 't3010_c16_aggregate_reporting',
    t1441Required: aggregateCad > thresholdCad,
    thresholdCad,
    note: 'Threshold is evaluated on aggregate grants to the same non-qualified donee during the fiscal period.'
  };
}
