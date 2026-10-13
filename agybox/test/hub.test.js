// Hub HTTP tests (H1-2: write API endpoints + config validation).
// Later tasks (H1-3, H1-4) extend this file — keep sections organized.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-hub-'));
const TOKEN = 'test-token-123';
process.env.AGYBOX_ROOT = ROOT;
process.env.AGYBOX_HUB_TOKEN = TOKEN;

const BIN = new URL('../bin/agybox', import.meta.url).pathname;
const { startHub } = await import('../hub/server.js');

let base, server, snapshotFn;
test.before(async () => {
  const started = await startHub({ port: 0 });
  server = started.server;
  snapshotFn = started.snapshot;
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

async function api(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

function stateFile() { return path.join(ROOT, 'supervisor-state.json'); }
function clearSupervisorState() { try { fs.unlinkSync(stateFile()); } catch {} }

// ---------------- auth ----------------

test('unauthorized without token', async () => {
  const r = await fetch(base + '/api/accounts');
  assert.equal(r.status, 401);
});

// ---------------- POST /api/rotate ----------------

test('POST /api/rotate writes a rotate request', async () => {
  assert.equal(spawnSync(process.execPath, [BIN, 'add', 'a', 'a@x'], { env: process.env }).status, 0);
  const r = await api('POST', '/api/rotate', { to: 'a' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(fs.existsSync(path.join(ROOT, 'rotate-request.json')));
  const bad = await api('POST', '/api/rotate', { to: 'ghost' });
  assert.equal(bad.status, 400);
});

test('POST /api/rotate rejects the currently active account', async () => {
  // carry-over (b): rotating to the account the supervisor is already on is meaningless
  fs.writeFileSync(stateFile(), JSON.stringify({ phase: 'active', account: 'a' }));
  try {
    const r = await api('POST', '/api/rotate', { to: 'a' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'target-is-active');
  } finally { clearSupervisorState(); }
});

test('POST /api/rotate hints when the supervisor is waiting for reset', async () => {
  // carry-over (a): the 5s poll does not read rotate requests while
  // WAITING_RESET; the response must say so instead of silently dropping the request
  fs.writeFileSync(stateFile(), JSON.stringify({ phase: 'waiting', account: 'b', wakeAt: Date.now() + 3600000 }));
  try {
    const r = await api('POST', '/api/rotate', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.match(r.json.note || '', /waiting/i);
    assert.match(r.json.note || '', /60s/);
    assert.ok(fs.existsSync(path.join(ROOT, 'rotate-request.json')), 'request file is written');
  } finally { clearSupervisorState(); }
});

// ---------------- error boundary (final-review fix wave) ----------------

test('a throwing route returns 500 and the hub process survives', async () => {
  // Process-survival property → test in a real child process: node --test
  // swallows unhandled rejections in-process, so an in-process variant
  // would hang instead of failing fast pre-fix. requestRotate() renames a
  // tmp file onto rotate-request.json; when that path is a directory the
  // rename throws EISDIR. Pre-boundary this was an unhandled rejection
  // that crashed the whole hub process.
  const { spawn } = await import('node:child_process');
  const { default: net } = await import('node:net');
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [BIN, 'hub', '--port', String(port)], {
    env: process.env, stdio: 'ignore',
  });
  const childBase = `http://127.0.0.1:${port}`;
  const childApi = async (method, p, body) => {
    const r = await fetch(childBase + p, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    // Wait for the child hub to accept requests.
    for (let i = 0; i < 50; i++) {
      try { if ((await childApi('GET', '/api/supervisor/state')).status === 200) break; } catch {}
      if (i === 49) throw new Error('child hub did not start');
      await new Promise(r => setTimeout(r, 100));
    }
    const reqFile = path.join(ROOT, 'rotate-request.json');
    try { fs.unlinkSync(reqFile); } catch {}
    fs.mkdirSync(reqFile);
    try {
      const r = await childApi('POST', '/api/rotate', {});
      assert.equal(r.status, 500);
      assert.equal(r.json.error, 'internal-error');
      // Hub still alive: a healthy endpoint responds, process still running.
      assert.equal(child.exitCode, null);
      const alive = await childApi('GET', '/api/supervisor/state');
      assert.equal(alive.status, 200);
    } finally {
      fs.rmdirSync(reqFile);
      try { fs.unlinkSync(`${reqFile}.${child.pid}.tmp`); } catch {}
    }
  } finally {
    child.kill('SIGTERM');
  }
});

// ---------------- POST /api/wait/cancel ----------------

test('POST /api/wait/cancel writes the cancel flag', async () => {
  const r = await api('POST', '/api/wait/cancel', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(fs.existsSync(path.join(ROOT, 'cancel-wait')));
  fs.unlinkSync(path.join(ROOT, 'cancel-wait'));
});

// ---------------- GET /api/handoffs ----------------

test('GET /api/handoffs lists handoff metadata only', async () => {
  const dir = path.join(ROOT, 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1-123.json'), JSON.stringify({
    schemaVersion: 1, sessionId: 's1', fromAccount: 'a', createdAt: 123,
    resumeMode: 'native', summary: 'x'.repeat(5000),
  }));
  const r = await api('GET', '/api/handoffs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.handoffs, [
    { sessionId: 's1', fromAccount: 'a', createdAt: 123, resumeMode: 'native' },
  ]);
});

// ---------------- PUT /api/config ----------------

test('PUT /api/config validates rotation policy', async () => {
  const ok = await api('PUT', '/api/config', { rotation: { maxRotationsPerSession: 4 } });
  assert.equal(ok.status, 200);
  const bad = await api('PUT', '/api/config', { rotation: { rotationCooldownSec: -5 } });
  assert.equal(bad.status, 400);
  const bad2 = await api('PUT', '/api/config', { rotation: { order: ['ghost'] } });
  assert.equal(bad2.status, 400);
});

test('PUT /api/config persists valid policy', async () => {
  const ok = await api('PUT', '/api/config', { rotation: { maxRotationsPerSession: 4, resetBufferSec: 120 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.equal(cfg.rotation.maxRotationsPerSession, 4);
  assert.equal(cfg.rotation.resetBufferSec, 120);
});

// ---------------- GET /api/supervisor/state ----------------

test('GET /api/supervisor/state reports unknown when idle', async () => {
  clearSupervisorState();
  const r = await api('GET', '/api/supervisor/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.phase, 'unknown');
});

// ---------------- POST /api/session/* (H1-3: hub-managed session) ----------------

test('session status cleans up a stale pid file', async () => {
  fs.writeFileSync(path.join(ROOT, 'hub-session.json'),
    JSON.stringify({ pid: 999999999, account: 'a', startedAt: 1 }));
  const st = (await api('GET', '/api/session/status')).json;
  assert.equal(st.running, false);
  assert.ok(!fs.existsSync(path.join(ROOT, 'hub-session.json')), 'stale pid file cleaned');
});

test('session start/stop lifecycle', async () => {
  const { installFakeDocker } = await import('./helpers/fake-docker.js');
  const oldPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-hubsess-'));
  process.env.PATH = installFakeDocker(dir) + ':' + oldPath;
  try {
    // account 'a' was registered by an earlier test; the fake prints 429 for
    // agy-a, so `run` enters WAITING_RESET (P2) and stays alive until stopped
    const start = await api('POST', '/api/session/start', { account: 'a' });
    assert.equal(start.status, 200);
    assert.equal(start.json.ok, true);
    const dup = await api('POST', '/api/session/start', { account: 'a' });
    assert.equal(dup.status, 409);
    // wait until the supervisor actually entered WAITING_RESET (P2 path through the hub)
    let tail = [];
    let saw = false;
    for (let i = 0; i < 60; i++) {
      const s = (await api('GET', '/api/session/status')).json;
      assert.ok(s.running, 'session should stay running');
      tail = s.tail;
      if (tail.some(l => l.includes('⏳'))) { saw = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(saw, 'supervisor should reach WAITING_RESET; tail:\n' + tail.join('\n'));
    const snap = await snapshotFn();
    assert.equal(snap.session.running, true, 'snapshot includes session status');
    assert.equal(snap.session.account, 'a');
    const stop = await api('POST', '/api/session/stop', {});
    assert.equal(stop.status, 200);
    let st2;
    for (let i = 0; i < 40; i++) {
      st2 = (await api('GET', '/api/session/status')).json;
      if (!st2.running) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(!st2.running, 'session should be stopped');
    assert.ok(!fs.existsSync(path.join(ROOT, 'hub-session.json')), 'pid file cleaned on stop');
  } finally {
    process.env.PATH = oldPath;
    try { await api('POST', '/api/session/stop', {}); } catch {} // never leak the child
  }
});

test('session start rejects unknown account', async () => {
  const r = await api('POST', '/api/session/start', { account: 'ghost' });
  assert.equal(r.status, 400);
});

// Regression: the hub must hold the child's stdin open. With stdio 'ignore'
// the supervised `agy` sees instant EOF and the session dies within a second;
// with an open pipe it stays alive (here: fake idles 4s, then exits 0).
test('session with healthy account stays alive (stdin held open)', async () => {
  const { installFakeDocker } = await import('./helpers/fake-docker.js');
  const oldPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-hubstdin-'));
  process.env.PATH = installFakeDocker(dir) + ':' + oldPath;
  try {
    assert.equal(spawnSync(process.execPath, [BIN, 'add', 'b', 'b@x'], { env: process.env }).status, 0);
    const start = await api('POST', '/api/session/start', { account: 'b' });
    assert.equal(start.status, 200);
    await new Promise(r => setTimeout(r, 1500));
    const s = (await api('GET', '/api/session/status')).json;
    assert.ok(s.running, 'session should stay alive past 1.5s; tail: ' + JSON.stringify(s.tail));
    assert.ok(s.tail.some(l => l.includes("supervised session on 'b'")), 'banner line in tail');
  } finally {
    process.env.PATH = oldPath;
    try { await api('POST', '/api/session/stop', {}); } catch {} // never leak the child
  }
  let st2;
  for (let i = 0; i < 40; i++) {
    st2 = (await api('GET', '/api/session/status')).json;
    if (!st2.running) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(!st2.running, 'session should be stopped');
});

// ---------------- hub restart orphan path (Review Focus 1) ----------------

test('hub restart recovers the managed session via the pid file', async () => {
  // Simulates a hub crash/restart WITHOUT killing any process: start the
  // session on a second hub instance, close that hub (child keeps running),
  // then verify a fresh hub sees the orphan via the pid file and can stop it.
  const { installFakeDocker } = await import('./helpers/fake-docker.js');
  const oldPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-hubrestart-'));
  process.env.PATH = installFakeDocker(dir) + ':' + oldPath;
  const hubs = []; // {server, base}
  const apiOn = (baseUrl) => async (method, p, body) => {
    const r = await fetch(baseUrl + p, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  const addHub = async () => {
    const h = await startHub({ port: 0 });
    const entry = { server: h.server, base: `http://127.0.0.1:${h.server.address().port}` };
    hubs.push(entry);
    return entry;
  };
  try {
    const hub2 = await addHub();
    const api2 = apiOn(hub2.base);
    // account 'a' registered earlier; fake 429 → run enters WAITING_RESET and stays alive
    const start = await api2('POST', '/api/session/start', { account: 'a' });
    assert.equal(start.status, 200);
    assert.equal(start.json.ok, true);
    let st;
    for (let i = 0; i < 60; i++) {
      st = (await api2('GET', '/api/session/status')).json;
      if (st.running) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(st.running, 'session should be running on the second hub');
    // "restart": close hub2 without touching the child process
    hub2.server.closeAllConnections?.();
    await new Promise(res => hub2.server.close(res));
    hubs.splice(hubs.indexOf(hub2), 1);
    // fresh hub: empty in-memory state, same AGYBOX_ROOT
    const hub3 = await addHub();
    const api3 = apiOn(hub3.base);
    const st3 = (await api3('GET', '/api/session/status')).json;
    assert.equal(st3.running, true, 'restarted hub must report the orphaned session as running');
    assert.equal(st3.account, 'a');
    assert.deepEqual(st3.tail, [], 'no in-memory log survives a restart');
    const stop = await api3('POST', '/api/session/stop', {});
    assert.equal(stop.status, 200);
    let st4;
    for (let i = 0; i < 40; i++) {
      st4 = (await api3('GET', '/api/session/status')).json;
      if (!st4.running) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(!st4.running, 'orphaned session should be stoppable via the new hub');
    assert.ok(!fs.existsSync(path.join(ROOT, 'hub-session.json')), 'pid file cleaned after stop');
  } finally {
    process.env.PATH = oldPath;
    for (const h of hubs) {
      try {
        await apiOn(h.base)('POST', '/api/session/stop', {});
      } catch {}
      h.server.closeAllConnections?.();
      await new Promise(res => h.server.close(res));
    }
  }
});

// ---------------- fix round 1: double-start race + recycled-PID guard ----------------

test('concurrent session starts: exactly one wins (409 for loser)', async () => {
  const { installFakeDocker } = await import('./helpers/fake-docker.js');
  const http = await import('node:http');
  const oldPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-hubrace-'));
  process.env.PATH = installFakeDocker(dir) + ':' + oldPath;
  try {
    // Ensure account 'a' exists even when this test runs standalone
    // (--test-name-pattern skips the earlier registration test).
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, [BIN, 'add', 'a', 'a@x'], { env: process.env });
    // True concurrency: separate TCP connections (agent:false, no keepalive)
    // and bodies completed only after BOTH handlers are parked in
    // readJSONBody. Without the in-flight guard both pass the running-check.
    const inFlight = [];
    function postStartStalled(body) {
      return new Promise((resolve, reject) => {
        const req = http.request(base + '/api/session/start', {
          method: 'POST', agent: false,
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        }, (res) => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
        });
        req.on('error', reject);
        const payload = JSON.stringify(body);
        req.write(payload.slice(0, 1)); // headers + 1 byte: handler starts, waits for body
        inFlight.push(() => req.end(payload.slice(1)));
      });
    }
    const p1 = postStartStalled({ account: 'a' });
    const p2 = postStartStalled({ account: 'a' });
    await new Promise(r => setTimeout(r, 300)); // both handlers now parked in readJSONBody
    for (const finish of inFlight) finish();
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409], `expected one 200 + one 409, got ${r1.status}/${r2.status}`);
    // Exactly one supervisor is tracked afterwards.
    let st;
    for (let i = 0; i < 40; i++) {
      st = (await api('GET', '/api/session/status')).json;
      if (st.running) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(st.running, 'exactly one session must be tracked as running');
    assert.ok(fs.existsSync(path.join(ROOT, 'hub-session.json')), 'pid file must exist');
    const stop = await api('POST', '/api/session/stop', {});
    assert.equal(stop.status, 200);
    for (let i = 0; i < 40; i++) {
      st = (await api('GET', '/api/session/status')).json;
      if (!st.running) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(!st.running, 'session should be stopped');
    assert.ok(!fs.existsSync(path.join(ROOT, 'hub-session.json')), 'pid file cleaned on stop');
  } finally {
    process.env.PATH = oldPath;
    try { await api('POST', '/api/session/stop', {}); } catch {} // never leak the child
  }
});

test('session status ignores a foreign pid (simulated recycle)', async () => {
  // Point the pid file at a live process that is NOT our child (this test
  // process): cmdline verification must reject it instead of trusting kill(0).
  fs.writeFileSync(path.join(ROOT, 'hub-session.json'),
    JSON.stringify({ pid: process.pid, account: 'a', startedAt: 1 }));
  const st = (await api('GET', '/api/session/status')).json;
  assert.equal(st.running, false, 'foreign pid must not be reported as running');
  assert.ok(!fs.existsSync(path.join(ROOT, 'hub-session.json')), 'foreign pid file cleaned');
});

test('session stop never signals a foreign pid', async () => {
  // If the hub signaled this pid, the test process itself would die — the
  // strongest possible assertion that the recycled-PID guard works.
  fs.writeFileSync(path.join(ROOT, 'hub-session.json'),
    JSON.stringify({ pid: process.pid, account: 'a', startedAt: 1 }));
  const r = await api('POST', '/api/session/stop', {});
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(ROOT, 'hub-session.json')), 'foreign pid file cleaned');
  const st = (await api('GET', '/api/session/status')).json;
  assert.equal(st.running, false);
});

// ---------------- accounts write API (H1-4: accounts CRUD + login verify) ----------------

test('accounts CRUD + verify', async () => {
  const add = await api('POST', '/api/accounts', { name: 'c', email: 'c@x' });
  assert.equal(add.status, 200);
  assert.equal(add.json.account.name, 'c');
  const dup = await api('POST', '/api/accounts', { name: 'c' });
  assert.equal(dup.status, 400);
  const verify = await api('POST', '/api/accounts/c/verify', {});
  assert.equal(verify.status, 200);
  assert.ok('quota' in verify.json || 'error' in verify.json);
  const del = await api('DELETE', '/api/accounts/c', {});
  assert.equal(del.status, 200);
  const del2 = await api('DELETE', '/api/accounts/c', {});
  assert.equal(del2.status, 404);
});

test('POST /api/accounts rejects invalid names', async () => {
  const bad = await api('POST', '/api/accounts', { name: '../evil' });
  assert.equal(bad.status, 400);
  const empty = await api('POST', '/api/accounts', {});
  assert.equal(empty.status, 400);
});

test('DELETE /api/accounts/:name refuses a live lock (409)', async () => {
  const add = await api('POST', '/api/accounts', { name: 'locked1' });
  assert.equal(add.status, 200);
  // Simulate a live supervisor lock with this test process's pid.
  fs.mkdirSync(path.join(ROOT, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'locks', 'locked1.json'),
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  try {
    const r = await api('DELETE', '/api/accounts/locked1', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'account-locked');
  } finally {
    fs.unlinkSync(path.join(ROOT, 'locks', 'locked1.json'));
  }
  const del = await api('DELETE', '/api/accounts/locked1', {});
  assert.equal(del.status, 200);
});

test('DELETE /api/accounts/:name treats a corrupt lock file as unlocked', async () => {
  // A lock file with a non-integer pid is corrupt, not held: Number.isInteger
  // guard in accountLocked() must not treat it as a live lock.
  const add = await api('POST', '/api/accounts', { name: 'corruptlock' });
  assert.equal(add.status, 200);
  fs.mkdirSync(path.join(ROOT, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'locks', 'corruptlock.json'),
    JSON.stringify({ pid: 'abc', startedAt: Date.now() }));
  try {
    const del = await api('DELETE', '/api/accounts/corruptlock', {});
    assert.equal(del.status, 200);
  } finally {
    try { fs.unlinkSync(path.join(ROOT, 'locks', 'corruptlock.json')); } catch {}
  }
});

test('POST /api/accounts/:name/verify 404s unknown accounts', async () => {
  const r = await api('POST', '/api/accounts/ghost/verify', {});
  assert.equal(r.status, 404);
});

// ---------------- POST /api/setup/:step + GET /api/tasks/:id (H2-1, H2-2) ----------------
// Uses the real SETUP_STEPS catalog. `docker-check` is check-only and safe on
// any machine; assertions stay environment-independent (docker may or may not
// be installed — either way the task completes with a non-empty detail).

test('POST /api/setup/:step runs the task in background and reports progress', async () => {
  const start = await api('POST', '/api/setup/docker-check');
  assert.equal(start.status, 200);
  assert.equal(start.json.ok, true);
  assert.ok(typeof start.json.taskId === 'string' && start.json.taskId.length > 0);
  // The response returned immediately; the task completes in the background.
  let final = null;
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/tasks/${start.json.taskId}`);
    assert.equal(r.status, 200);
    if (r.json.status === 'ok' || r.json.status === 'failed') { final = r.json; break; }
    await new Promise(res => setTimeout(res, 100));
  }
  assert.ok(final, 'task should complete in the background');
  assert.ok(['ok', 'failed'].includes(final.status), 'docker-check completes either way');
  assert.equal(final.steps.length, 1);
  assert.equal(final.steps[0].id, 'docker-check');
  assert.ok(final.steps[0].detail.length > 0, 'step should report what it found');
});

test('POST /api/setup/:step honors dryRun without writing anything', async () => {
  const start = await api('POST', '/api/setup/autostart', { dryRun: true });
  assert.equal(start.status, 200);
  let final = null;
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/tasks/${start.json.taskId}`);
    if (r.json.status === 'ok' || r.json.status === 'failed') { final = r.json; break; }
    await new Promise(res => setTimeout(res, 100));
  }
  assert.ok(final, 'task should complete in the background');
  assert.equal(final.status, 'ok');
  // Dry-run never writes: either the unit is already installed (check passes)
  // or the run reports what it WOULD write.
  assert.match(final.steps[0].detail, /would write|already|installed/);
});

test('POST /api/setup/:step 404s unknown steps; GET /api/tasks/:id 404s unknown tasks', async () => {
  const bad = await api('POST', '/api/setup/no-such-step');
  assert.equal(bad.status, 404);
  assert.equal(bad.json.error, 'unknown-step');
  const noTask = await api('GET', '/api/tasks/does-not-exist');
  assert.equal(noTask.status, 404);
  assert.equal(noTask.json.error, 'unknown-task');
});

// ---------------- GET /api/setup/steps + GET /api/tailscale (H2-3) ----------------

test('GET /api/setup/steps returns the checklist with live check results', async () => {
  const r = await api('GET', '/api/setup/steps');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.steps));
  assert.equal(r.json.steps.length, 4);
  for (const s of r.json.steps) {
    assert.ok(typeof s.id === 'string' && s.id.length > 0);
    assert.ok(typeof s.label === 'string' && s.label.length > 0);
    assert.equal(typeof s.ok, 'boolean');
    assert.equal(typeof s.detail, 'string');
    assert.ok(Array.isArray(s.manual));
    assert.equal(typeof s.runnable, 'boolean');
  }
  const byId = Object.fromEntries(r.json.steps.map(s => [s.id, s]));
  assert.equal(byId.autostart.runnable, true); // the only one-click step
  assert.equal(byId['docker-check'].runnable, false);
  assert.equal(byId['image-check'].runnable, false); // informational only — no Dockerfile
  assert.equal(byId['plugin-check'].runnable, false);
});

test('GET /api/setup/steps?fresh=1 bypasses the docker cache', async () => {
  const r = await api('GET', '/api/setup/steps?fresh=1');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.steps));
});

test('GET /api/tailscale never fails', async () => {
  const r = await api('GET', '/api/tailscale');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.installed, 'boolean');
  assert.equal(typeof r.json.connected, 'boolean');
});
