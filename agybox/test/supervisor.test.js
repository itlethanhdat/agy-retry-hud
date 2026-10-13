import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { SupervisedSession, rotateOnce } from '../lib/supervisor.js';

// fake child: exits 0 on receiving '/exit' on stdin
function fakeSpawn() {
  const handlers = {};
  const child = { stdin: { write(d) { if (String(d).trim() === '/exit') setImmediate(() => handlers.exit?.(0)); } },
    stdout: { on() {} }, stderr: { on() {} }, killed: false,
    kill(sig) { this.killed = sig; setImmediate(() => handlers.exit?.(null, sig)); },
    on(e, cb) { handlers[e] = cb; } };
  return child;
}

test('gracefulStop writes /exit and resolves on exit', async () => {
  const s = new SupervisedSession({ spawnFn: fakeSpawn });
  s.start('agy', []); let exited = false; s.on('exit', () => exited = true);
  await s.gracefulStop(1000);
  assert.equal(exited, true);
});

test('gracefulStop SIGTERMs after timeout', async () => {
  const children = [];
  const hanging = () => { const c = fakeSpawn(); c.stdin.write = () => {}; children.push(c); return c; };
  const s = new SupervisedSession({ spawnFn: hanging });
  s.start('agy', []);
  await s.gracefulStop(50);
  assert.equal(children[0].killed, 'SIGTERM');
});

test('emits line events per complete line', async () => {
  const lines = [];
  let stdoutCb = null;
  const src = () => ({ stdin: { write() {} },
    stdout: { on(e, cb) { if (e === 'data') stdoutCb = cb; } }, stderr: { on() {} },
    kill() {}, on() {} });
  const s = new SupervisedSession({ spawnFn: src });
  s.start('agy', []);
  s.on('line', l => lines.push(l));
  stdoutCb('hello\npar');
  stdoutCb('tial\nworld\n');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(lines, ['hello', 'partial', 'world']);
});

// ---- rotateOnce ----

function fakeSession() {
  return { stopped: false, written: [],
    async gracefulStop() { this.stopped = true; },
    write(d) { this.written.push(d); },
    on() {}, };
}
const POL = { order: ['a', 'b'], verifyTimeoutSec: 1, maxRotationsPerSession: 8, rotationCooldownSec: 0, resumeGraceMs: 50 };
const q0 = { buckets: [{ window: '5h', remainingFraction: 0, resetAt: 1 }] };
const qHalf = { buckets: [{ window: '5h', remainingFraction: 0.5, resetAt: 1 }] };

test('rotateOnce keeps session when verify shows quota remains', async () => {
  let spawned = 0;
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a' },
    accounts: [{ name: 'a' }, { name: 'b' }],
    getQuota: async () => qHalf,
    policy: POL,
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 's1' },
    handoffDir: fs.mkdtempSync(path.join(os.tmpdir(), 'h5-')), now: 100000,
    spawnFor: () => { spawned++; return fakeSession(); } });
  assert.deepEqual(r, { kept: true, reason: 'not-exhausted' });
  assert.equal(spawned, 0);
});

test('rotateOnce rotates to next account and resumes natively', async () => {
  const spawned = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h5-'));
  const sess = fakeSession();
  const r = await rotateOnce({ session: sess, activeAccount: { name: 'a', container: 'agy-a' },
    accounts: [{ name: 'a', container: 'agy-a' }, { name: 'b', container: 'agy-b' }],
    getQuota: async (n) => n === 'a' ? q0 : qHalf,
    policy: POL,
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 'sess-1' },
    handoffDir: dir, now: 100000,
    spawnFor: (account, args) => { spawned.push([account.name, args]); return fakeSession(); } });
  assert.equal(r.to, 'b'); assert.equal(r.resumeMode, 'native'); assert.equal(r.sessionId, 'sess-1');
  assert.equal(sess.stopped, true);
  assert.deepEqual(spawned[0], ['b', ['--resume', 'sess-1']]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const h = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(h.resumeMode, 'native'); assert.equal(h.fromAccount, 'a');
});

test('rotateOnce falls back to handoff-inject when resume fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h5-'));
  let n = 0;
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a', container: 'agy-a' },
    accounts: [{ name: 'a', container: 'agy-a' }, { name: 'b', container: 'agy-b' }],
    getQuota: async (nm) => nm === 'a' ? q0 : qHalf,
    policy: POL,
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 'sess-9', summary: 'refactor auth' },
    handoffDir: dir, now: 100000,
    spawnFor: (account, args) => {
      n++;
      if (n === 1) { // resume attempt exits non-zero quickly
        const f = fakeSession();
        setImmediate(() => f.exitCb?.({ code: 1 }));
        f.on = (e, cb) => { if (e === 'exit') f.exitCb = cb; };
        return f;
      }
      return fakeSession();
    } });
  assert.equal(r.to, 'b'); assert.equal(r.resumeMode, 'handoff-inject');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const h = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(h.resumeMode, 'handoff-inject');
  assert.ok(r.session.written.some(w => w.includes('refactor auth')));
});

test('rotateOnce returns exhausted when nobody has quota', async () => {
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a' },
    accounts: [{ name: 'a' }, { name: 'b' }],
    getQuota: async () => q0,
    policy: POL,
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 's1' },
    handoffDir: fs.mkdtempSync(path.join(os.tmpdir(), 'h5-')), now: 100000,
    spawnFor: () => { throw new Error('must not spawn'); } });
  assert.deepEqual(r, { exhausted: true });
});

test('rotateOnce keeps session when verify times out', async () => {
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a' },
    accounts: [{ name: 'a' }, { name: 'b' }],
    getQuota: () => new Promise(() => {}), // hangs forever
    policy: { ...POL, verifyTimeoutSec: 0.05 },
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 's1' },
    handoffDir: fs.mkdtempSync(path.join(os.tmpdir(), 'h5-')), now: 100000,
    spawnFor: () => { throw new Error('must not spawn'); } });
  assert.deepEqual(r, { kept: true, reason: 'verify-failed' });
});

test('rotateOnce tries next candidate when spawn throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h5-'));
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a', container: 'agy-a' },
    accounts: [{ name: 'a', container: 'agy-a' }, { name: 'b', container: 'agy-b' }, { name: 'c', container: 'agy-c' }],
    getQuota: async (n) => n === 'a' ? q0 : qHalf,
    policy: POL,
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 's-spawn' },
    handoffDir: dir, now: 100000,
    spawnFor: (account) => { if (account.name === 'b') throw new Error('docker boom'); return fakeSession(); } });
  assert.equal(r.to, 'c');
});

test('rotateOnce returns exhausted when all spawns throw', async () => {
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a', container: 'agy-a' },
    accounts: [{ name: 'a', container: 'agy-a' }, { name: 'b', container: 'agy-b' }],
    getQuota: async (n) => n === 'a' ? q0 : qHalf,
    policy: POL,
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 's-spawn2' },
    handoffDir: fs.mkdtempSync(path.join(os.tmpdir(), 'h5-')), now: 100000,
    spawnFor: () => { throw new Error('docker boom'); } });
  assert.deepEqual(r, { exhausted: true });
});

test('getGitInfo reads HEAD and dirty files', async () => {
  const { execFileSync } = await import('node:child_process');
  const { getGitInfo } = await import('../lib/supervisor.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'y');
  const gi = getGitInfo(dir);
  assert.match(gi.gitHead, /^[0-9a-f]{40}$/);
  assert.ok(gi.gitDirty.some(l => l.includes('f.txt')));
});

test('getGitInfo returns empty for non-repo', async () => {
  const { getGitInfo } = await import('../lib/supervisor.js');
  assert.deepEqual(getGitInfo('/nonexistent-dir-xyz-agybox'), { gitHead: '', gitDirty: [] });
});
