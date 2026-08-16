/**
 * Planning-level Canadian disbursement quota calculator.
 * This is not tax/legal advice. Production calculations must ingest the charity's
 * actual T3010/DQ inputs and current CRA rules.
 */
export function calculateTieredDQ(eligiblePropertyCad, {
  lowerRate = 0.035,
  upperRate = 0.05,
  thresholdCad = 1_000_000,
} = {}) {
  if (!Number.isFinite(eligiblePropertyCad) || eligiblePropertyCad < 0) {
    throw new TypeError('eligiblePropertyCad must be a non-negative finite number');
  }
  const lowerBase = Math.min(eligiblePropertyCad, thresholdCad);
  const upperBase = Math.max(0, eligiblePropertyCad - thresholdCad);
  return lowerBase * lowerRate + upperBase * upperRate;
}

export function calculateFlatScenarioDQ(assetPoolCad, rate = 0.05) {
  if (!Number.isFinite(assetPoolCad) || assetPoolCad < 0) throw new TypeError('assetPoolCad must be non-negative');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new TypeError('rate must be between 0 and 1');
  return assetPoolCad * rate;
}

export function investmentScenario(assetPoolCad, annualReturn, dqRate, years = 1) {
  if (years < 1 || !Number.isInteger(years)) throw new TypeError('years must be a positive integer');
  let assets = assetPoolCad;
  let cumulativeReturn = 0;
  let cumulativeDisbursement = 0;
  const rows = [];
  for (let year = 1; year <= years; year++) {
    const grossReturn = assets * annualReturn;
    const disbursement = assets * dqRate;
    assets = assets + grossReturn - disbursement;
    cumulativeReturn += grossReturn;
    cumulativeDisbursement += disbursement;
    rows.push({year, openingAssetsCad: assets - grossReturn + disbursement, grossReturnCad: grossReturn, disbursementCad: disbursement, closingAssetsCad: assets});
  }
  return {rows, closingAssetsCad: assets, cumulativeReturnCad: cumulativeReturn, cumulativeDisbursementCad: cumulativeDisbursement};
}
