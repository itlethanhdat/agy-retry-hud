// Setup steps with capability detection (H2-2). All docker access is
// injected via ctx so tests never need a real daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETUP_STEPS } = await import('../lib/setup-steps.js');
const byId = (id) => SETUP_STEPS.find((s) => s.id === id);

test('SETUP_STEPS has the four expected ids in order', () => {
  assert.deepEqual(SETUP_STEPS.map((s) => s.id),
    ['docker-check', 'image-check', 'plugin-check', 'autostart']);
});

test('check-only steps expose run:null', () => {
  for (const id of ['docker-check', 'image-check', 'plugin-check']) {
    assert.equal(byId(id).run, null, `${id} must be check-only`);
  }
  assert.equal(typeof byId('autostart').run, 'function');
});

test('docker-check reports missing docker honestly', async () => {
  const r = await byId('docker-check').check({ dockerAvailable: () => false });
  assert.equal(r.ok, false);
  assert.match(r.manual.join(' '), /docker/i);
});

test('docker-check reports the version when present', async () => {
  const r = await byId('docker-check').check({
    dockerAvailable: () => true,
    sh: () => ({ status: 0, stdout: 'Docker version 28.0.0, build abc\n', stderr: '' }),
  });
  assert.equal(r.ok, true);
  assert.match(r.detail, /Docker version 28\.0\.0/);
});

test('image-check without docker is honest', async () => {
  const r = await byId('image-check').check({ dockerAvailable: () => false });
  assert.equal(r.ok, false);
  assert.ok(r.manual.length > 0);
});

test('image-check detects a present vs missing image', async () => {
  const present = await byId('image-check').check({
    dockerAvailable: () => true,
    sh: () => ({ status: 0, stdout: 'abc123def456\n', stderr: '' }),
  });
  assert.equal(present.ok, true);
  assert.match(present.detail, /agybox:latest/);

  const missing = await byId('image-check').check({
    dockerAvailable: () => true,
    sh: () => ({ status: 0, stdout: '\n', stderr: '' }),
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.manual.length > 0, 'must tell the user how to get the image');
});

test('plugin-check reports per-account status', async () => {
  const accounts = [
    { name: 'a', container: 'agy-a' },
    { name: 'b', container: 'agy-b' },
  ];
  // agy-a has the plugin, agy-b does not.
  const sh = (cmd, args) => ({
    status: args.includes('agy-a') ? 0 : 1, stdout: '', stderr: '',
  });
  const r = await byId('plugin-check').check({
    dockerAvailable: () => true, sh, listAccounts: () => accounts,
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /: b$/); // only the missing account is named
  assert.ok(r.manual.length > 0);
});

test('plugin-check is ok when every container has the plugin', async () => {
  const r = await byId('plugin-check').check({
    dockerAvailable: () => true,
    sh: () => ({ status: 0, stdout: '', stderr: '' }),
    listAccounts: () => [{ name: 'a', container: 'agy-a' }],
  });
  assert.equal(r.ok, true);
});

test('plugin-check without docker is honest', async () => {
  const r = await byId('plugin-check').check({ dockerAvailable: () => false });
  assert.equal(r.ok, false);
  assert.ok(r.manual.length > 0);
});

test('autostart check detects an installed unit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-check-'));
  fs.mkdirSync(path.join(dir, '.config', 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.config', 'systemd', 'user', 'agybox-hub.service'), 'x');
  const r = await byId('autostart').check({ home: dir });
  assert.equal(r.ok, true);
});

test('autostart check reports missing unit with manual enable step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-missing-'));
  const r = await byId('autostart').check({ home: dir });
  assert.equal(r.ok, false);
  assert.ok(r.manual.join(' ').includes('systemctl'));
});

test('autostart dry-run writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  const r = await byId('autostart').run({ home: dir, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(!fs.existsSync(path.join(dir, '.config', 'systemd', 'user', 'agybox-hub.service')));
});

test('autostart run writes the unit file and names the enable command', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-run-'));
  const r = await byId('autostart').run({ home: dir });
  const unitPath = path.join(dir, '.config', 'systemd', 'user', 'agybox-hub.service');
  assert.ok(fs.existsSync(unitPath), 'unit file should be written');
  const content = fs.readFileSync(unitPath, 'utf8');
  assert.match(content, /\[Unit\]/);
  assert.match(content, /agybox/);
  assert.match(content, /hub/);
  assert.match(r.detail, /systemctl --user enable/);
});
