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
