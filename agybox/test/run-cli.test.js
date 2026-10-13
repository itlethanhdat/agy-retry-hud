import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-cli-'));
const BIN = new URL('../bin/agybox', import.meta.url).pathname;
function agybox(...args) {
  return spawnSync(process.execPath, [BIN, ...args],
    { encoding: 'utf8', env: { ...process.env, AGYBOX_ROOT: ROOT } });
}
function lockFile(name) { return path.join(ROOT, 'locks', `${name}.json`); }

test('run refuses when docker is unavailable', () => {
  agybox('add', 'a', 'a@x');
  const r = agybox('run', '--account', 'a');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /docker/i);
});

test('rotate with unknown account errors', () => {
  const r = agybox('rotate', 'ghost');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown account/i);
});

test('run refuses when a live lock exists', () => {
  fs.mkdirSync(path.dirname(lockFile('a')), { recursive: true });
  fs.writeFileSync(lockFile('a'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const r = agybox('run', '--account', 'a');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /already/i);
});

test('run clears a stale lock and proceeds', () => {
  fs.writeFileSync(lockFile('a'), JSON.stringify({ pid: 999999999, startedAt: 1 }));
  const r = agybox('run', '--account', 'a');
  // stale lock cleared → gets past locking, then fails on docker (unavailable here)
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /docker/i);
  assert.doesNotMatch(r.stderr + r.stdout, /already/i);
  assert.ok(!fs.existsSync(lockFile('a')), 'stale lock file removed');
});

test('cancel-wait creates the flag file', () => {
  const r = agybox('cancel-wait');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(ROOT, 'cancel-wait')));
});

test('run holds the waiting lock: second run for same account is refused', () => {
  agybox('add', 'b', 'b@x');
  fs.mkdirSync(path.dirname(lockFile('b')), { recursive: true });
  fs.writeFileSync(lockFile('b'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const r = agybox('run', '--account', 'b');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /already/i);
});
