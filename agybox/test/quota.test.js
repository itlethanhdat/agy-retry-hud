import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

test('parseUsagePayload matches quotaFromStatus on fixture payloads', async () => {
  const { quotaFromStatus } = await import('../../src/native.js');
  // NOTE: the plan draft compared 3-key objects against quotaFromStatus'
  // 4-key objects; that can never be deep-equal. Compare full shapes.
  const payloads = [
    { quota: { 'x 5h': { remaining_fraction: 0.5, reset_in_seconds: 100 } } },
    { quota: { 'Foo weekly': { remaining_fraction: 0, reset_time: new Date(Date.now() + 3600000).toISOString() } } },
    { quota: {} },
  ];
  for (const p of payloads) {
    const a = parseUsagePayload(p, 1000).buckets;
    const b = quotaFromStatus(p, 1000);
    assert.deepEqual(
      a.map(({ name, window, remainingFraction, resetAt }) => ({ name, window, remainingFraction, resetAt })), b);
  }
});

test('parseUsagePayload preserves camelCase tolerant variants', () => {
  const p = parseUsagePayload({ quota: {
    a: { remainingFraction: 0.25, resetInSeconds: 60 },
    b: { remainingFraction: 0.75, resetTime: new Date(NOW + 5000).toISOString() },
    c: { remaining_fraction: 0.5, resetTime: new Date(NOW + 6000).toISOString() },
  } }, NOW);
  assert.equal(p.buckets.length, 3);
  assert.equal(p.buckets.find(b => b.name === 'a').resetAt, NOW + 60_000);
  assert.equal(p.buckets.find(b => b.name === 'b').resetAt, NOW + 5000);
  assert.equal(p.buckets.find(b => b.name === 'c').resetAt, NOW + 6000);
});

test('parseUsagePayload preserves the buckets-array form', () => {
  const p = parseUsagePayload({ buckets: [
    { name: 'x 5h', remaining_fraction: 0.5, reset_in_seconds: 30 },
    { window: 'weekly', remainingFraction: 0.1, resetInSeconds: 40 },
  ] }, NOW);
  assert.equal(p.buckets.length, 2);
  assert.equal(p.buckets[0].resetAt, NOW + 30_000);
  assert.equal(p.buckets[0].window, '5h');
  assert.equal(p.buckets[1].name, 'weekly');
  assert.equal(p.buckets[1].window, 'weekly');
  assert.equal(p.buckets[1].resetAt, NOW + 40_000);
});

test('parseUsagePayload keeps 5_hour window mapping', () => {
  const p = parseUsagePayload({ quota: { 'x 5_hour': { remaining_fraction: 0.5, reset_in_seconds: 10 } } }, NOW);
  assert.equal(p.buckets.length, 1);
  assert.equal(p.buckets[0].window, '5h');
});

test('parseUsagePayload preserves mixed snake/camel shapes', () => {
  const p = parseUsagePayload({ quota: {
    m1: { remainingFraction: 0.3, reset_in_seconds: 70 },
    m2: { remaining_fraction: 0.4, resetInSeconds: 80 },
  } }, NOW);
  assert.equal(p.buckets.length, 2);
  assert.equal(p.buckets.find(b => b.name === 'm1').resetAt, NOW + 70_000);
  assert.equal(p.buckets.find(b => b.name === 'm2').resetAt, NOW + 80_000);
});

test('parseUsagePayload return shape is {buckets, checkedAt}', () => {
  const p = parseUsagePayload({ quota: {} }, NOW);
  assert.deepEqual(Object.keys(p).sort(), ['buckets', 'checkedAt']);
  assert.equal(p.checkedAt, NOW);
});

test('importing quota.js has no side effects', async () => {
  const before = fs.readdirSync(os.tmpdir()).length;
  await import('../lib/quota.js');
  await import('../../src/native.js');
  assert.ok(fs.readdirSync(os.tmpdir()).length - before < 2, 'imports must not create stray files');
});

test('resetTime string wins over reset_in_seconds in mixed-shape buckets (old precedence)', () => {
  const iso = new Date(NOW + 7_000).toISOString();
  // quota-object branch
  const p = parseUsagePayload({ quota: {
    mix: { remaining_fraction: 0.5, resetTime: iso, reset_in_seconds: 9999 },
  } }, NOW);
  assert.equal(p.buckets.length, 1);
  assert.equal(p.buckets[0].resetAt, NOW + 7_000);
  // buckets-array branch
  const pa = parseUsagePayload({ buckets: [
    { name: 'x 5h', remaining_fraction: 0.5, resetTime: iso, reset_in_seconds: 9999 },
  ] }, NOW);
  assert.equal(pa.buckets.length, 1);
  assert.equal(pa.buckets[0].resetAt, NOW + 7_000);
});
