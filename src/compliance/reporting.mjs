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
      currentCraRouting: {
        t3010Line5050: 'Include total qualifying disbursements by way of gifts to qualified donees.',
        supportingWorksheet: 'T1236 / qualified-donee reporting as applicable to the current filing package.'
      },
      note: 'Exact filing fields must be validated against the T3010 package in force for the fiscal period.'
    };
  }

  const overThreshold = aggregateCad > thresholdCad;
  return {
    recipientType,
    aggregateCad,
    route: overThreshold ? 't1441_individual_grant_reporting' : 't3010_c16_aggregate_reporting',
    t1441Required: overThreshold,
    thresholdCad,
    currentCraRouting: overThreshold ? {
      t3010Line5840: 'Yes — grants to non-qualified donees were made.',
      t3010Line5841: 'Yes — this grantee received more than $5,000 in aggregate during the fiscal period.',
      t1441: 'Report each individual grant to this grantee.',
      t3010Line5045: 'Include all grants to non-qualified donees in the fiscal-period total.'
    } : {
      t3010Line5840: 'Yes — grants to non-qualified donees were made.',
      t3010Lines5842_5843: 'Include grantee count and aggregate amounts for grantees receiving $5,000 or less in total.',
      t3010Line5045: 'Include all grants to non-qualified donees in the fiscal-period total.'
    },
    note: 'The $5,000 threshold is evaluated on aggregate grants to the same non-qualified donee during the fiscal period; amounts over the threshold are then reported grant-by-grant on T1441.'
  };
}
