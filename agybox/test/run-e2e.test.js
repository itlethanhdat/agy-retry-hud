import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { installFakeDocker } from './helpers/fake-docker.js';

// Full P1 loop against fake docker:
// run(a) → 429 signal → verify → rotate to b (lock a→b) → b's session ends
// on its own → run must exit 0 (not hang) and release the lock.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-rune2e-'));
const BIN = new URL('../bin/agybox', import.meta.url).pathname;
const FAKEBIN = installFakeDocker(ROOT);
const ENV = { ...process.env, AGYBOX_ROOT: ROOT, PATH: FAKEBIN + ':' + process.env.PATH };
const locks = n => path.join(ROOT, 'locks', `${n}.json`);

test('supervised run: rotation transfers lock, natural session end exits 0', async () => {
  assert.equal(spawnSync(process.execPath, [BIN, 'add', 'a', 'a@x'], { encoding: 'utf8', env: ENV }).status, 0);
  assert.equal(spawnSync(process.execPath, [BIN, 'add', 'b', 'b@x'], { encoding: 'utf8', env: ENV }).status, 0);

  const proc = spawn(process.execPath, [BIN, 'run'], { encoding: 'utf8', env: ENV });
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => out += d);

  const t0 = Date.now();
  let rotated = false;
  while (Date.now() - t0 < 25000) {
    if (fs.existsSync(locks('b')) && !fs.existsSync(locks('a'))) { rotated = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(rotated, 'expected lock transfer a → b; output:\n' + out);
  assert.match(out, /⟳ a → b/);

  const code = await Promise.race([
    new Promise(res => proc.on('exit', c => res(c))),
    new Promise(res => setTimeout(() => res('timeout'), 20000)),
  ]);
  assert.equal(code, 0, 'run must exit 0 when the session ends instead of hanging; output:\n' + out);
  const leftovers = fs.existsSync(path.join(ROOT, 'locks')) ? fs.readdirSync(path.join(ROOT, 'locks')) : [];
  assert.deepEqual(leftovers, [], 'locks must be released on exit');
});

// Full P2 loop against fake docker (single account):
// run(a) → 429 → verify: all exhausted → WAITING_RESET (⏳) → reset "happens"
// (marker file) → wake → re-verify → auto-resume --resume → session ends → exit 0.
test('supervised run: waits for nearest reset, then auto-resumes', async () => {
  const ROOT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-waite2e-'));
  const FAKEBIN2 = installFakeDocker(ROOT2);
  const marker = path.join(ROOT2, 'quota-ok');
  const ENV2 = { ...process.env, AGYBOX_ROOT: ROOT2, PATH: FAKEBIN2 + ':' + process.env.PATH,
    FAKE_RESET_IN_SECONDS: '2', FAKE_QUOTA_OK_FILE: marker };
  fs.writeFileSync(path.join(ROOT2, 'config.json'), JSON.stringify({
    rotation: { resetBufferSec: 1, waitRecheckSec: 1, verifyTimeoutSec: 1 },
  }));
  assert.equal(spawnSync(process.execPath, [BIN, 'add', 'a', 'a@x'], { encoding: 'utf8', env: ENV2 }).status, 0);
  // a stale cancel flag from a previous run must not abort this fresh wait
  fs.writeFileSync(path.join(ROOT2, 'cancel-wait'), 'stale');

  const proc = spawn(process.execPath, [BIN, 'run'], { encoding: 'utf8', env: ENV2 });
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => out += d);

  // wait until the supervisor enters WAITING_RESET, then simulate the reset
  const t0 = Date.now();
  let waiting = false;
  while (Date.now() - t0 < 15000) {
    if (out.includes('⏳')) { waiting = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(waiting, 'expected WAITING_RESET countdown; output:\n' + out);
  await new Promise(r => setTimeout(r, 1000));
  fs.writeFileSync(marker, 'reset happened');

  const code = await Promise.race([
    new Promise(res => proc.on('exit', c => res(c))),
    new Promise(res => setTimeout(() => res('timeout'), 30000)),
  ]);
  assert.match(out, /đã có quota sau reset/, 'expected auto-resume message; output:\n' + out);
  assert.equal(code, 0, 'run must exit 0 after auto-resume and natural session end; output:\n' + out);
  const leftovers = fs.existsSync(path.join(ROOT2, 'locks')) ? fs.readdirSync(path.join(ROOT2, 'locks')) : [];
  assert.deepEqual(leftovers, [], 'locks must be released on exit');
});

// Lock race during wait: b is picked for waiting but its lock is held by a
// live pid → the supervisor must exit(4), never hang lockless (zombie).
test('waiting: lock race on the picked account exits 4 instead of hanging', async () => {
  const ROOT3 = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-lockrace-'));
  const FAKEBIN3 = installFakeDocker(ROOT3);
  const ENV3 = { ...process.env, AGYBOX_ROOT: ROOT3, PATH: FAKEBIN3 + ':' + process.env.PATH,
    FAKE_RESET_IN_SECONDS: '2', FAKE_ALL_EXHAUSTED: '1' };
  fs.writeFileSync(path.join(ROOT3, 'config.json'), JSON.stringify({
    rotation: { resetBufferSec: 1, waitRecheckSec: 1, verifyTimeoutSec: 1 },
  }));
  assert.equal(spawnSync(process.execPath, [BIN, 'add', 'b', 'b@x'], { encoding: 'utf8', env: ENV3 }).status, 0);
  assert.equal(spawnSync(process.execPath, [BIN, 'add', 'a', 'a@x'], { encoding: 'utf8', env: ENV3 }).status, 0);
  // b's lock held by a live pid (this test process)
  fs.mkdirSync(path.join(ROOT3, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(ROOT3, 'locks', 'b.json'),
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

  const proc = spawn(process.execPath, [BIN, 'run', '--account', 'a'], { encoding: 'utf8', env: ENV3 });
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => out += d);
  const code = await Promise.race([
    new Promise(res => proc.on('exit', c => res(c))),
    new Promise(res => setTimeout(() => res('timeout'), 25000)),
  ]);
  assert.match(out, /không giữ được lock 'b'/, 'expected lock-race message; output:\n' + out);
  assert.equal(code, 4, 'expected exit 4 on lock race, not a hang; output:\n' + out);
});
