import test from 'node:test';
import assert from 'node:assert/strict';
import { matchQuotaSignal } from '../lib/signals.js';

test('matches known quota-exhaustion lines', () => {
  assert.equal(matchQuotaSignal('Error 429: RESOURCE_EXHAUSTED'), true);
  assert.equal(matchQuotaSignal('Quota exceeded for 5h window, please wait'), true);
  assert.equal(matchQuotaSignal('You have reached your weekly limit. Upgrade to continue.'), true);
});

test('does not match ordinary lines', () => {
  assert.equal(matchQuotaSignal('Compiling 42 files... done'), false);
  assert.equal(matchQuotaSignal('4294967296 bytes written'), false);
});
