import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWorkspaceMapping, volumeArgsFor, loadConfig } from '../lib/config.js';

// isolate sandbox root for tests
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-test-'));
process.env.AGYBOX_ROOT = tmpRoot;
const wsDir = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsDir, { recursive: true });

test('default config has main workspace mapping', () => {
  const cfg = loadConfig();
  assert.equal(cfg.workspaces[0].containerPath, '/workspace');
  assert.equal(cfg.rotation.maxRotationsPerSession, 8);
  assert.equal(cfg.hub.port, 8765);
});

test('validateWorkspaceMapping accepts a good mapping', () => {
  const r = validateWorkspaceMapping({ name: 'main', hostPath: wsDir, containerPath: '/workspace', mode: 'rw', scope: 'global' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateWorkspaceMapping rejects bad mappings', () => {
  const base = { name: 'x', hostPath: wsDir, containerPath: '/w', mode: 'rw', scope: 'global' };
  assert.equal(validateWorkspaceMapping({ ...base, hostPath: '/nope/nada' }).ok, false);
  assert.equal(validateWorkspaceMapping({ ...base, containerPath: 'relative' }).ok, false);
  assert.equal(validateWorkspaceMapping({ ...base, mode: 'xx' }).ok, false);
  assert.equal(validateWorkspaceMapping({ ...base, scope: 'account:ghost' }).ok, false);
  // sensitive path → warning error
  const ssh = path.join(tmpRoot, '.ssh'); fs.mkdirSync(ssh);
  const r = validateWorkspaceMapping({ ...base, hostPath: ssh });
  // only warns when it matches real ~/.ssh; tmpRoot .ssh is fine
  assert.equal(r.ok, true);
});

test('volumeArgsFor builds -v args and skips invalid', () => {
  const cfg = loadConfig();
  cfg.workspaces = [
    { name: 'main', hostPath: wsDir, containerPath: '/workspace', mode: 'rw', scope: 'global' },
    { name: 'ro', hostPath: wsDir, containerPath: '/data', mode: 'ro', scope: 'global' },
    { name: 'bad', hostPath: '/nope', containerPath: '/bad', mode: 'rw', scope: 'global' },
  ];
  const args = volumeArgsFor('acc1', cfg);
  assert.deepEqual(args, ['-v', `${wsDir}:/workspace`, '-v', `${wsDir}:/data:ro`]);
});
