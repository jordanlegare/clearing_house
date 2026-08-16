import test from 'node:test';
import assert from 'node:assert/strict';
import { offerTokenHash, buildOfferUrl, OfferAccessError } from '../src/workflow/offer_access.mjs';

test('offer capability hashes are deterministic and do not expose raw token', () => {
  const token = 'A'.repeat(43);
  const digest = offerTokenHash(token);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, offerTokenHash(token));
  assert.notEqual(digest, token);
});

test('offer URL requires an absolute HTTP(S) base and preserves the token as one path segment', () => {
  const token = 'Abc_123-'.repeat(6).slice(0, 48);
  assert.equal(buildOfferUrl('https://offers.example.ca/', token), `https://offers.example.ca/offer/${token}`);
  assert.throws(() => buildOfferUrl('/relative', token), /absolute HTTP/);
});

test('offer access errors default to a non-enumerating gone response', () => {
  const error = new OfferAccessError();
  assert.equal(error.statusCode, 410);
  assert.match(error.message, /invalid, expired, or already used/);
});
