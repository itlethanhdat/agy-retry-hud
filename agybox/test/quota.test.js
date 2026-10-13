import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsagePayload, nearestResetAt, isExhausted, fmtCountdown } from '../lib/quota.js';

const NOW = 1_790_900_000_000;

test('parses statusline-style quota with reset_time string', () => {
  const p = parseUsagePayload({
    quota: {
      'gemini 5h': { remaining_fraction: 0.42, reset_time: new Date(NOW + 3_600_000).toISOString() },
      'weekly': { remaining_fraction: 0.9, reset_time: new Date(NOW + 86_400_000).toISOString() },
    },
  }, NOW);
  assert.equal(p.buckets.length, 2);
  const b5 = p.buckets.find(b => b.window === '5h');
  assert.equal(b5.remainingFraction, 0.42);
  assert.equal(b5.resetAt, NOW + 3_600_000);
});

test('parses reset_in_seconds variant', () => {
  const p = parseUsagePayload({ quota: { 'x 5-hour': { remaining_fraction: 0, reset_in_seconds: 120 } } }, NOW);
  assert.equal(p.buckets[0].resetAt, NOW + 120_000);
  assert.equal(p.buckets[0].window, '5h');
});

test('skips invalid buckets', () => {
  const p = parseUsagePayload({ quota: { bad: { remaining_fraction: 2, reset_time: 'x' }, ok: { remaining_fraction: 0.5, reset_in_seconds: 10 } } }, NOW);
  assert.equal(p.buckets.length, 1);
  assert.equal(p.buckets[0].name, 'ok');
});

test('nearestResetAt picks minimum', () => {
  assert.equal(nearestResetAt([{ resetAt: 300 }, { resetAt: 100 }]), 100);
  assert.equal(nearestResetAt([]), null);
});

test('isExhausted', () => {
  const b = [{ window: '5h', remainingFraction: 0 }, { window: 'weekly', remainingFraction: 0.5 }];
  assert.equal(isExhausted(b, '5h'), true);
  assert.equal(isExhausted(b, 'weekly'), false);
  assert.equal(isExhausted(b, 'daily'), null);
});

test('fmtCountdown', () => {
  assert.equal(fmtCountdown(90_000), '01:30');
  assert.equal(fmtCountdown(3_700_000), '01:01:40');
  assert.equal(fmtCountdown(90_000_000), '1d 01:00');
});
