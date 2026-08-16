import { calculateFlatScenarioDQ, investmentScenario } from '../domain/dq.mjs';
import { capacitySaved } from '../domain/capacity.mjs';

export function nationalAllocationScenario({
  foundationAssetsCad = 135_000_000_000,
  annualReturn = 0.085,
  dqRate = 0.05,
  registeredCharities = 87_000,
  additionalDoneeShare = 0.20
} = {}) {
  const additionalDonees = Math.round(registeredCharities * additionalDoneeShare);
  const recipientUniverse = registeredCharities + additionalDonees;
  const dqCad = calculateFlatScenarioDQ(foundationAssetsCad, dqRate);
  const grossReturnCad = foundationAssetsCad * annualReturn;
  return {
    foundationAssetsCad,
    annualReturn,
    dqRate,
    grossReturnCad,
    dqCad,
    residualBeforeFeesCad: grossReturnCad - dqCad,
    registeredCharities,
    additionalDonees,
    recipientUniverse,
    equalAllocationBenchmarkCad: recipientUniverse ? dqCad / recipientUniverse : 0,
    administrativeCapacity: capacitySaved(recipientUniverse),
    oneYearCapital: investmentScenario(foundationAssetsCad, annualReturn, dqRate, 1)
  };
}
