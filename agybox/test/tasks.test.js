// Async task framework (H2-1): createTask / runTask / getTask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, runTask, getTask } from '../lib/tasks.js';

test('runTask executes steps in order and stops on failure', async () => {
  const events = [];
  const t = createTask('demo', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]);
  await runTask(t, {
    a: async () => ({ detail: 'did a' }),
    b: async () => { throw new Error('boom'); },
  }, (snap) => events.push(snap.status));
  assert.equal(t.steps[0].status, 'ok');
  assert.equal(t.steps[1].status, 'failed');
  assert.equal(t.steps[2].status, 'skipped');
  assert.equal(t.status, 'failed');
  assert.ok(events.length >= 3);
  assert.equal(getTask(t.id).id, t.id);
});

test('runTask marks missing impl as failed, not crash', async () => {
  const t = createTask('demo2', [{ id: 'x', label: 'X' }]);
  await runTask(t, {}, () => {});
  assert.equal(t.steps[0].status, 'failed');
});

test('createTask builds the documented shape and registers the task', () => {
  const t = createTask('shape', [{ id: 's1', label: 'Step one' }]);
  assert.equal(t.status, 'pending');
  assert.equal(typeof t.id, 'string');
  assert.ok(t.id.length > 0);
  assert.ok(Number.isFinite(t.createdAt));
  assert.deepEqual(t.steps, [{ id: 's1', label: 'Step one', status: 'pending', detail: '' }]);
  assert.equal(getTask(t.id), t);
  assert.equal(getTask('no-such-task'), null);
});

test('runTask happy path marks everything ok and reports details', async () => {
  const events = [];
  const t = createTask('happy', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
  await runTask(t, {
    a: async () => ({ detail: 'did a' }),
    b: async () => ({}),
  }, (snap) => events.push(snap.steps.map(s => s.status).join(',')));
  assert.equal(t.status, 'ok');
  assert.deepEqual(t.steps.map(s => s.status), ['ok', 'ok']);
  assert.equal(t.steps[0].detail, 'did a');
  assert.ok(events.length >= 4, 'progress after every step transition');
});
