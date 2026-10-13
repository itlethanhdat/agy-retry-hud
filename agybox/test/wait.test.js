import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNearestResetAccount } from '../lib/wait.js';

const acc = n => ({ name: n });
const q = (w5, ww) => ({ buckets: [
  ...(w5 ? [{ window: '5h', remainingFraction: 0, resetAt: w5 }] : []),
  ...(ww ? [{ window: 'weekly', remainingFraction: 0, resetAt: ww }] : []),
]});

test('picks the account with the nearest 5h reset', () => {
  const r = pickNearestResetAccount([acc('a'), acc('b')],
    new Map([['a', q(3000)], ['b', q(1000)]]));
  assert.equal(r.account.name, 'b'); assert.equal(r.resetAt, 1000); assert.equal(r.window, '5h');
});

test('falls back to weekly when no 5h reset is known', () => {
  const r = pickNearestResetAccount([acc('a'), acc('b')],
    new Map([['a', q(null, 5000)], ['b', q(9000)]]));
  assert.equal(r.account.name, 'a'); assert.equal(r.window, 'weekly');
});

test('returns null when no reset time is known', () => {
  assert.equal(pickNearestResetAccount([acc('a')], new Map([['a', { error: 'x' }]])), null);
  assert.equal(pickNearestResetAccount([acc('a')], new Map([['a', { buckets: [] }]])), null);
});

test('waitUntilWake wakes at the time', async () => {
  const { waitUntilWake } = await import('../lib/wait.js');
  let t = 1000;
  const clock = { now: () => t, sleep: async ms => { t += ms; } };
  const r = await waitUntilWake({ wakeAt: 5000, cancelFile: '/nonexistent-xyz-agybox', pollMs: 1000, clock });
  assert.deepEqual(r, { woken: true });
  assert.ok(t >= 5000);
});

test('waitUntilWake returns immediately when wakeAt is past', async () => {
  const { waitUntilWake } = await import('../lib/wait.js');
  let slept = false;
  const clock = { now: () => 9000, sleep: async () => { slept = true; } };
  const r = await waitUntilWake({ wakeAt: 5000, cancelFile: '/nonexistent-xyz-agybox', clock });
  assert.deepEqual(r, { woken: true }); assert.equal(slept, false);
});

test('waitUntilWake observes the cancel file', async () => {
  const { waitUntilWake } = await import('../lib/wait.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-'));
  const cancelFile = path.join(dir, 'cancel');
  let t = 0;
  const clock = { now: () => t, sleep: async ms => { t += ms; if (t >= 3000) fs.writeFileSync(cancelFile, ''); } };
  const r = await waitUntilWake({ wakeAt: 99999, cancelFile, pollMs: 1000, clock });
  assert.deepEqual(r, { cancelled: true });
  assert.ok(!fs.existsSync(cancelFile), 'cancel file is consumed');
});
