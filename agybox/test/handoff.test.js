import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildHandoff, writeHandoff, HANDOFF_SCHEMA_VERSION } from '../lib/handoff.js';

test('buildHandoff produces the spec shape', () => {
  const h = buildHandoff({ sessionId: 'abc', fromAccount: 'acc1', cwd: '/w', gitHead: '9f3',
    gitDirty: ['a.ts'], summary: 'refactor auth', pendingTodos: ['lint'], interruptedTool: null, now: 1000 });
  assert.equal(h.schemaVersion, HANDOFF_SCHEMA_VERSION);
  assert.equal(h.sessionId, 'abc'); assert.equal(h.fromAccount, 'acc1');
  assert.deepEqual(h.gitDirty, ['a.ts']); assert.equal(h.createdAt, 1000);
  assert.ok(!('token' in h) && !JSON.stringify(h).includes('antigravity-oauth-token'));
});

test('writeHandoff writes atomically with 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  const fp = writeHandoff(dir, buildHandoff({ sessionId: 's1', fromAccount: 'a', cwd: '', gitHead: '', gitDirty: [], summary: '', pendingTodos: [], interruptedTool: null, now: 7 }));
  assert.ok(fs.existsSync(fp)); assert.equal((fs.statSync(fp).mode & 0o777), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).sessionId, 's1');
});

test('summarizeTranscript keeps the tail within limits', async () => {
  const { summarizeTranscript } = await import('../lib/handoff.js');
  const lines = Array.from({ length: 500 }, (_, i) => `L${String(i).padStart(4, '0')}-` + 'x'.repeat(40));
  const s = summarizeTranscript(lines);
  assert.ok(!s.includes('L0000-'), 'old head must be dropped');
  assert.ok(s.includes('L0499-'), 'tail must be kept');
  assert.ok(s.length <= 4000, `length capped, got ${s.length}`);
  assert.equal(summarizeTranscript([]), '');
});
