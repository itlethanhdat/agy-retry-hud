import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { rotateOnce } from '../lib/supervisor.js';

// End-to-end rotation loop with a stubbed quota source (no docker needed:
// the docker seam is getQuota, injected). Proves the full P1 contract:
// signal → verify → select → handoff → graceful stop → respawn --resume.
test('full rotation loop with stubbed quota source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const quotas = { a: { buckets: [{ window: '5h', remainingFraction: 0, resetAt: 1 }] },
                   b: { buckets: [{ window: '5h', remainingFraction: 0.7, resetAt: 1 }] } };
  const events = [];
  const session = { async gracefulStop() { events.push('stopped'); }, write() {}, on() {} };
  const r = await rotateOnce({ session, activeAccount: { name: 'a', container: 'agy-a' },
    accounts: [{ name: 'a', container: 'agy-a' }, { name: 'b', container: 'agy-b' }],
    getQuota: async (name) => quotas[name],
    policy: { order: ['a', 'b'], verifyTimeoutSec: 1, maxRotationsPerSession: 8, rotationCooldownSec: 0, resumeGraceMs: 50 },
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 'sess-1' },
    handoffDir: dir, now: 200000,
    spawnFor: (account, args) => { events.push(`spawn:${account.name}:${args.join(' ')}`); return session; } });
  assert.equal(r.to, 'b');
  assert.ok(events.includes('stopped'));
  assert.ok(events.some(e => e.startsWith('spawn:b:--resume sess-1')));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const h = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(h.resumeMode, 'native'); assert.equal(h.fromAccount, 'a');
});
