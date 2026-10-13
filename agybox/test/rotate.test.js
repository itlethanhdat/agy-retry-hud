import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNextAccount, nextRotationAllowed } from '../lib/rotate.js';

const acc = n => ({ name: n });
const q = (f5, err) => err ? { name: '', error: err } : { buckets: [{ window: '5h', remainingFraction: f5, resetAt: 1 }] };

test('selects next account in order, skipping exhausted and active', () => {
  const r = selectNextAccount({ accounts: [acc('a'), acc('b'), acc('c')],
    quotas: new Map([['a', q(0)], ['b', q(0.5)], ['c', q(0.9)]]),
    order: ['a', 'b', 'c'], activeName: 'a', notBefore: new Map(), now: 0 });
  assert.equal(r.name, 'b');
});

test('returns null when all others exhausted', () => {
  const r = selectNextAccount({ accounts: [acc('a'), acc('b')],
    quotas: new Map([['a', q(0)], ['b', q(0)]]),
    order: ['a', 'b'], activeName: 'a', notBefore: new Map(), now: 0 });
  assert.equal(r, null);
});

test('respects notBefore cooldown map', () => {
  const r = selectNextAccount({ accounts: [acc('a'), acc('b')],
    quotas: new Map([['a', q(0)], ['b', q(0.5)]]),
    order: ['a', 'b'], activeName: 'a', notBefore: new Map([['b', 999]]), now: 0 });
  assert.equal(r, null);
});

test('nextRotationAllowed enforces max rotations and cooldown', () => {
  const policy = { maxRotationsPerSession: 2, rotationCooldownSec: 30 };
  assert.equal(nextRotationAllowed({ rotationsThisSession: 2, lastRotationAt: 0, policy, now: 1000 }).allowed, false);
  assert.equal(nextRotationAllowed({ rotationsThisSession: 0, lastRotationAt: 0, policy, now: 1000 }).allowed, false);
  assert.equal(nextRotationAllowed({ rotationsThisSession: 0, lastRotationAt: 0, policy, now: 40000 }).allowed, true);
});
