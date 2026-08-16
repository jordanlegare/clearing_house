import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewBundleHash } from '../src/workflow/review_bundles.mjs';

const base = {
  foundationOrgId: '00000000-0000-4000-8000-000000000001',
  policyId: '00000000-0000-4000-8000-000000000002',
  policyVersion: 3,
  items: [
    { grantId: '00000000-0000-4000-8000-000000000010', recipientOrgId: '00000000-0000-4000-8000-000000000020', amountCad: 25000 },
    { grantId: '00000000-0000-4000-8000-000000000011', recipientOrgId: '00000000-0000-4000-8000-000000000021', amountCad: 37500.25 }
  ]
};

test('review bundle hash is order-independent and cent-exact', () => {
  const a = reviewBundleHash(base);
  const b = reviewBundleHash({ ...base, items: [...base.items].reverse() });
  const c = reviewBundleHash({ ...base, items: [{ ...base.items[0], amountCad: 25000.01 }, base.items[1]] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('review bundle hash binds policy version and recipient identity', () => {
  const a = reviewBundleHash(base);
  assert.notEqual(a, reviewBundleHash({ ...base, policyVersion: 4 }));
  assert.notEqual(a, reviewBundleHash({ ...base, items: [{ ...base.items[0], recipientOrgId: '00000000-0000-4000-8000-000000000099' }, base.items[1]] }));
});
