export const DEFAULT_HOURS_SAVED = Object.freeze({ nonprofit: 40, foundation: 12, government: 1 });

export function capacitySaved(transactions, hours = DEFAULT_HOURS_SAVED, fteHours = 1800) {
  if (!Number.isInteger(transactions) || transactions < 0) throw new TypeError('transactions must be a non-negative integer');
  const bySector = Object.fromEntries(Object.entries(hours).map(([sector, perGrant]) => [sector, transactions * perGrant]));
  const totalHours = Object.values(bySector).reduce((a,b) => a+b, 0);
  return { transactions, bySector, totalHours, fteYears: totalHours / fteHours };
}
