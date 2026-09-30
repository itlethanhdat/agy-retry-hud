import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const verifier = path.join(root, 'scripts', 'verify-plugin-package.js');

test('staged plugin has plugin.json at the root and validates structurally', () => {
  const pluginRoot = path.join(root, 'plugin', 'agy-retry-hud');
  assert.equal(fs.existsSync(path.join(pluginRoot, 'plugin.json')), true);assert.equal(fs.existsSync(path.join(pluginRoot,'setup.js')),true);assert.equal(fs.existsSync(path.join(pluginRoot,'config.example.json')),true);
  const r = spawnSync(process.execPath, [verifier, pluginRoot], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.name, 'agy-retry-hud');
});

test('full project root is rejected with the nested plugin path hint', () => {
  const r = spawnSync(process.execPath, [verifier, root], {encoding:'utf8'});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /full project/i);
  assert.match(r.stderr, /plugin[\\/]agy-retry-hud/);
});
