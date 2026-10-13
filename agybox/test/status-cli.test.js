import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { installFakeDocker } from './helpers/fake-docker.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-status-'));
const BIN = new URL('../bin/agybox', import.meta.url).pathname;
const FAKEBIN = installFakeDocker(ROOT);
const ENV = { ...process.env, AGYBOX_ROOT: ROOT, PATH: FAKEBIN + ':' + process.env.PATH };

test('status renders real quota percentages (not ?) with docker', () => {
  let r = spawnSync(process.execPath, [BIN, 'add', 'a', 'a@x'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [BIN, 'add', 'b', 'b@x'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [BIN, 'status'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /70%/, 'expected b to show 70%, got:\n' + r.stdout);
  assert.doesNotMatch(r.stdout, /\?\s+\?/, 'quota columns must not render ?');
});
