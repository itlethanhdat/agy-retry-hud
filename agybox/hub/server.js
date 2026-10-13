// agy hub — local web management UI (H0: read-only).
// Serves SPA + JSON API + SSE. Token auth, binds localhost by default.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { sandboxRoot, loadConfig, saveConfig } from '../lib/config.js';
import { resetDockerCache } from '../lib/docker.js';
import { refreshAllQuotas, getAccount, loadAccounts, addAccount, removeAccount, refreshAccountQuota } from '../lib/accounts.js';
import { requestRotate } from '../lib/supervisor.js';
import { createTask, runTask, getTask } from '../lib/tasks.js';
import { SETUP_STEPS } from '../lib/setup-steps.js';
import { startManagedSession, stopManagedSession, pidIsAlive, pidIsManagedSession } from './session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const BIN_PATH = path.join(here, '..', 'bin', 'agybox');

function tokenFile() { return path.join(sandboxRoot(), 'hub-token'); }
export function getHubToken() {
  if (process.env.AGYBOX_HUB_TOKEN) return process.env.AGYBOX_HUB_TOKEN;
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (t) return t;
  } catch { /* create below */ }
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(sandboxRoot(), { recursive: true });
  fs.writeFileSync(tokenFile(), t + '\n', { mode: 0o600 });
  return t;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** readJSONBody(req) => parsed object; empty body => {}. Never throws on empty. */
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/** Best-effort supervisor state; {phase:'unknown'} when nothing is running. */
function readSupervisorState(root) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'supervisor-state.json'), 'utf8'));
    if (s && typeof s.phase === 'string') return s;
  } catch {}
  return { phase: 'unknown' };
}

/**
 * probeTailscale() => {installed, connected, ip|null}. Best-effort: every
 * failure mode (binary missing, not logged in, timeout) is caught and
 * reported as data — this must never throw, the Setup page depends on it.
 */
function probeTailscale() {
  try {
    const st = spawnSync('tailscale', ['status'], { encoding: 'utf8', timeout: 5000 });
    if (st.status !== 0) return { installed: true, connected: false, ip: null };
    let ip = null;
    try {
      const ipr = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 });
      if (ipr.status === 0) ip = (ipr.stdout || '').trim().split('\n')[0].trim() || null;
    } catch { /* ip is optional */ }
    return { installed: true, connected: true, ip };
  } catch {
    return { installed: false, connected: false, ip: null };
  }
}

/**
 * accountLocked(root, name) => true when the account's lock is held by a live
 * pid. Read-only — unlike acquireLock it never clears a stale lock, because a
 * hub DELETE must not mutate supervisor state as a side effect. A corrupt
 * lock file (non-integer pid) counts as unlocked, not held.
 */
function accountLocked(root, name) {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(root, 'locks', `${name}.json`), 'utf8'));
    if (Number.isInteger(cur?.pid)) {
      try { process.kill(cur.pid, 0); return true; }
      catch (e) { return e.code !== 'ESRCH'; }
    }
  } catch {}
  return false;
}

const ROTATION_FIELDS = ['order', 'maxRotationsPerSession', 'rotationCooldownSec', 'verifyTimeoutSec', 'resetBufferSec', 'waitRecheckSec'];
const ROTATION_RANGES = {
  maxRotationsPerSession: [1, 32], rotationCooldownSec: [0, 3600],
  verifyTimeoutSec: [5, 120], resetBufferSec: [0, 900], waitRecheckSec: [10, 3600],
};

/** validateRotation(patch, accounts) => string[] violations (empty = valid). */
function validateRotation(patch, accounts) {
  const errs = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['rotation must be an object'];
  if ('order' in patch) {
    const names = new Set(accounts.map(a => a.name));
    if (!Array.isArray(patch.order) || patch.order.some(n => typeof n !== 'string' || !names.has(n)))
      errs.push('order must be an array of known account names');
  }
  for (const [k, [lo, hi]] of Object.entries(ROTATION_RANGES)) {
    if (k in patch) {
      const v = patch[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
        errs.push(`${k} must be a number between ${lo} and ${hi}`);
    }
  }
  return errs;
}

/** listHandoffs(root) => [{sessionId, fromAccount, createdAt, resumeMode}] newest first. */
function listHandoffs(root) {
  const dir = path.join(root, 'handoffs');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ sessionId: h.sessionId || '', fromAccount: h.fromAccount || '', createdAt: h.createdAt || 0, resumeMode: h.resumeMode || null });
    } catch { /* skip corrupt files */ }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * setupStepDef(entry) => {id, label, steps:[{id,label}], impls} — adapter from
 * the SETUP_STEPS catalog (lib/setup-steps.js) to the tasks framework.
 *
 * Design: ONE framework step per setup entry. The impl runs check() first,
 * then run() when the check fails and a run exists (e.g. autostart installs
 * the unit). A check-only entry whose capability is missing FAILS the step —
 * surfacing `manual` instructions — instead of reporting a misleading green
 * checkmark. The hub never injects deps, so steps use real implementations;
 * unit tests inject stubs directly on the step functions.
 */
function setupStepDef(entry) {
  return {
    id: entry.id,
    label: entry.label,
    steps: [{ id: entry.id, label: entry.label }],
    impls: {
      [entry.id]: async (api) => {
        const checked = await entry.check(api.deps || {});
        if (checked.ok) return { detail: checked.detail };
        if (typeof entry.run === 'function') {
          const acted = await entry.run({ ...(api.deps || {}), dryRun: !!api.dryRun });
          return { detail: `${checked.detail} — ${acted.detail}` };
        }
        const manual = checked.manual?.length ? ` — ${checked.manual.join(' ')}` : '';
        throw new Error(`${checked.detail}${manual}`);
      },
    },
  };
}

export async function startHub({ port = 8765, open = false, listen = '127.0.0.1' } = {}) {
  const token = getHubToken();
  const clients = new Set();
  const root = sandboxRoot();

  // ---- hub-managed supervised session (H1-3) ----
  // One handle in memory + pid file, so a hub restart still sees the session.
  let managed = null;
  // Synchronous in-flight guard for POST /api/session/start: set BEFORE the
  // first await in the handler so two concurrent starts can't both pass the
  // running-check and spawn a supervisor (the check-then-spawn spans awaits).
  let starting = false;
  const sessionPidFile = () => path.join(root, 'hub-session.json');
  function readSessionPidFile() {
    try {
      const info = JSON.parse(fs.readFileSync(sessionPidFile(), 'utf8'));
      if (info && Number.isInteger(info.pid)) return info;
    } catch {}
    return null;
  }
  function clearSessionPidFile() { try { fs.unlinkSync(sessionPidFile()); } catch {} }
  /** sessionSummary() => {running, account, startedAt} — cheap, for the SSE snapshot. */
  function sessionSummary() {
    if (managed && !managed.spawnError && managed.proc.exitCode === null && managed.proc.signalCode === null)
      return { running: true, account: managed.account, startedAt: managed.startedAt };
    const info = readSessionPidFile();
    if (info) {
      const identity = pidIsManagedSession(info.pid, BIN_PATH);
      // null + dead pid (Linux): process is gone → stale.
      // null + live pid: /proc unavailable (non-Linux) → existence fallback only.
      if (identity === true || (identity === null && pidIsAlive(info.pid)))
        return { running: true, account: info.account || null, startedAt: info.startedAt || null };
      clearSessionPidFile(); // stale or foreign (recycled PID) — never claim it
    }
    return { running: false, account: null, startedAt: null };
  }
  /** sessionStatus() => sessionSummary() + tail (last 50 log lines, in-memory only). */
  function sessionStatus() {
    const s = sessionSummary();
    if (s.running && managed) return { ...s, tail: managed.log.slice(-50) };
    return { ...s, tail: [] };
  }

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
  }
  async function snapshot() {
    return { ts: Date.now(), accounts: refreshAllQuotas(), config: { workspaces: loadConfig().workspaces }, session: sessionSummary() };
  }

  const server = http.createServer(async (req, res) => {
    // Top-level error boundary: a throw in any route must never become an
    // unhandled rejection (Node exits the whole hub process). The try wraps
    // the entire handler body (indentation intentionally not re-flowed to
    // keep this diff minimal); the catch converts any throw into a 500.
    try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // ---- auth (skip for nothing; every route needs it) ----
    const q = url.searchParams.get('token');
    const h = req.headers.authorization || '';
    const ok = q === token || h === `Bearer ${token}`;
    if (!ok) { sendJSON(res, { error: 'unauthorized' }, 401); return; }

    // ---- API ----
    if (p === '/api/accounts' && req.method === 'GET') { sendJSON(res, { accounts: refreshAllQuotas() }); return; }
    if (p === '/api/config' && req.method === 'GET') {
      const cfg = loadConfig();
      sendJSON(res, { workspaces: cfg.workspaces, rotation: cfg.rotation, hub: cfg.hub });
      return;
    }
    // ---- write API (H1 actions) ----
    if (p === '/api/rotate' && req.method === 'POST') {
      let body;
      try { body = await readJSONBody(req); } catch { sendJSON(res, { error: 'invalid-json' }, 400); return; }
      const to = body.to ?? null;
      if (to !== null && !getAccount(to)) { sendJSON(res, { error: 'unknown-account' }, 400); return; }
      const root = sandboxRoot();
      const st = readSupervisorState(root);
      if (to !== null && st.account && to === st.account && st.phase !== 'unknown') {
        sendJSON(res, { error: 'target-is-active' }, 400); return;
      }
      requestRotate(root, { to, source: 'hub' });
      const out = { ok: true, to };
      // H1-1's poll does not read rotate-requests while WAITING_RESET; a request
      // left unread for >60s is consumed as stale — it takes effect only if the
      // supervisor leaves the waiting state within 60s. Say so instead of
      // silently dropping it.
      if (st.phase === 'waiting') out.note = 'supervisor is waiting for quota reset; request is recorded but only takes effect if the supervisor leaves the waiting state within 60s, otherwise it is dropped as stale';
      sendJSON(res, out); return;
    }
    if (p === '/api/wait/cancel' && req.method === 'POST') {
      fs.writeFileSync(path.join(sandboxRoot(), 'cancel-wait'), '');
      sendJSON(res, { ok: true }); return;
    }
    if (p === '/api/handoffs' && req.method === 'GET') {
      sendJSON(res, { handoffs: listHandoffs(sandboxRoot()) }); return;
    }
    if (p === '/api/supervisor/state' && req.method === 'GET') {
      sendJSON(res, readSupervisorState(sandboxRoot())); return;
    }
    if (p === '/api/config' && req.method === 'PUT') {
      let body;
      try { body = await readJSONBody(req); } catch { sendJSON(res, { error: 'invalid-json' }, 400); return; }
      const violations = validateRotation(body.rotation, loadAccounts());
      if (violations.length) { sendJSON(res, { error: violations.join('; ') }, 400); return; }
      const cfg = loadConfig();
      for (const k of ROTATION_FIELDS) if (k in body.rotation) cfg.rotation[k] = body.rotation[k];
      saveConfig(cfg); // atomic (tmp + rename)
      sendJSON(res, { ok: true }); return;
    }
    // ---- accounts write API (H1-4) ----
    // POST /api/accounts {name, email?} — create (400 on invalid/duplicate)
    // DELETE /api/accounts/:name — 409 when a live supervisor lock is held,
    //   404 when unknown; removeAccount's own container guard is preserved
    // POST /api/accounts/:name/verify — force quota refresh (the "Verify"
    //   button of the guided manual login flow; no OAuth automation here)
    {
      const segs = p.split('/').filter(Boolean);
      const isAccounts = segs[0] === 'api' && segs[1] === 'accounts';
      if (isAccounts && segs.length === 2 && req.method === 'POST') {
        let body;
        try { body = await readJSONBody(req); } catch { sendJSON(res, { error: 'invalid-json' }, 400); return; }
        try {
          const account = addAccount({ name: body.name, email: body.email ?? '' });
          sendJSON(res, { ok: true, account });
        } catch (e) {
          sendJSON(res, { error: String(e?.message || e) }, 400);
        }
        return;
      }
      if (isAccounts && segs.length === 4 && segs[3] === 'verify' && req.method === 'POST') {
        let name;
        try { name = decodeURIComponent(segs[2]); } catch { sendJSON(res, { error: 'invalid-name' }, 400); return; }
        if (!getAccount(name)) { sendJSON(res, { error: 'unknown-account' }, 404); return; }
        const q = refreshAccountQuota(name, { force: true });
        if (q.error) sendJSON(res, { ok: false, error: q.error });
        else sendJSON(res, { ok: true, quota: q });
        return;
      }
      if (isAccounts && segs.length === 3 && req.method === 'DELETE') {
        let name;
        try { name = decodeURIComponent(segs[2]); } catch { sendJSON(res, { error: 'invalid-name' }, 400); return; }
        if (!getAccount(name)) { sendJSON(res, { error: 'unknown-account' }, 404); return; }
        if (accountLocked(root, name)) { sendJSON(res, { error: 'account-locked' }, 409); return; }
        try {
          removeAccount(name);
          sendJSON(res, { ok: true });
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes('is running')) sendJSON(res, { error: 'container-running', detail: msg }, 409);
          else sendJSON(res, { error: msg }, 400);
        }
        return;
      }
    }
    // ---- setup tasks (H2-1) ----
    // POST /api/setup/:step — create the step's task and run it in
    // BACKGROUND (never awaited); returns {ok:true, taskId} immediately.
    // 404 for unknown step.
    // GET /api/tasks/:id — task JSON or 404.
    // Every step transition is broadcast as SSE `task-progress`.
    {
      const segs = p.split('/').filter(Boolean);
      if (segs[0] === 'api' && segs[1] === 'setup' && segs.length === 3 && req.method === 'POST') {
        let stepId;
        try { stepId = decodeURIComponent(segs[2]); } catch { sendJSON(res, { error: 'invalid-step' }, 400); return; }
        const entry = SETUP_STEPS.find((s) => s.id === stepId);
        if (!entry) { sendJSON(res, { error: 'unknown-step' }, 404); return; }
        // Optional body {dryRun:true} — read-only preview of what run() would do.
        let dryRun = false;
        try { dryRun = (await readJSONBody(req)).dryRun === true; } catch { sendJSON(res, { error: 'invalid-json' }, 400); return; }
        const def = setupStepDef(entry);
        const task = createTask(def.label, def.steps);
        // Background: runTask never throws (per-step try/catch), but guard
        // anyway so an unexpected error can't become an unhandled rejection.
        runTask(task, def.impls, (t) => broadcast('task-progress', t), { root, dryRun }).catch(() => {});
        sendJSON(res, { ok: true, taskId: task.id });
        return;
      }
      if (segs[0] === 'api' && segs[1] === 'tasks' && segs.length === 3 && req.method === 'GET') {
        let id;
        try { id = decodeURIComponent(segs[2]); } catch { sendJSON(res, { error: 'invalid-id' }, 400); return; }
        const task = getTask(id);
        if (!task) { sendJSON(res, { error: 'unknown-task' }, 404); return; }
        sendJSON(res, task);
        return;
      }
    }
    // ---- setup checklist (H2-3) ----
    // GET /api/setup/steps — run every step's check() and return the list.
    // Checks are read-only and fast, so the UI always shows fresh results.
    // ?fresh=1 bypasses the dockerAvailable() cache (a Docker installed while
    // the hub runs would otherwise stay invisible until restart).
    if (p === '/api/setup/steps' && req.method === 'GET') {
      if (url.searchParams.get('fresh') === '1') resetDockerCache();
      const steps = [];
      for (const entry of SETUP_STEPS) {
        let result;
        try { result = await entry.check({}); }
        catch (e) { result = { ok: false, detail: String(e?.message || e) }; }
        steps.push({
          id: entry.id,
          label: entry.label,
          ok: !!result.ok,
          detail: result.detail || '',
          manual: Array.isArray(result.manual) ? result.manual : [],
          // runnable=false (check-only, e.g. image-check) → the UI shows the
          // result + manual text with NO "Run" button, never a fake fix.
          runnable: typeof entry.run === 'function',
        });
      }
      sendJSON(res, { steps });
      return;
    }
    // GET /api/tailscale — best-effort probe for the phone-access guide.
    // Never fails: every error mode is reported as data.
    if (p === '/api/tailscale' && req.method === 'GET') {
      sendJSON(res, probeTailscale());
      return;
    }
    if (p === '/api/session/start' && req.method === 'POST') {
      // Set synchronously BEFORE the first await: the second of two
      // concurrent starts gets 409 here instead of racing through the check.
      if (starting || sessionSummary().running) { sendJSON(res, { error: 'session-already-running' }, 409); return; }
      starting = true;
      try {
        let body;
        try { body = await readJSONBody(req); } catch { sendJSON(res, { error: 'invalid-json' }, 400); return; }
        const account = body.account ?? null;
        if (account !== null && !getAccount(account)) { sendJSON(res, { error: 'unknown-account' }, 400); return; }
        const handle = await startManagedSession({
          account, binPath: BIN_PATH, env: process.env,
          onLog: (line) => broadcast('session-log', { line }),
        });
        handle.proc.on('exit', () => {
          if (managed === handle) managed = null;
          // Only clear the pid file if it still refers to THIS child —
          // never clobber another session's registration.
          const info = readSessionPidFile();
          if (info && info.pid === handle.proc.pid) clearSessionPidFile();
        });
        fs.writeFileSync(sessionPidFile(), JSON.stringify({ pid: handle.proc.pid, account: handle.account, startedAt: handle.startedAt }));
        managed = handle;
        sendJSON(res, { ok: true, account: handle.account, startedAt: handle.startedAt });
      } catch (e) {
        sendJSON(res, { error: 'start-failed', detail: String(e?.message || e) }, 500);
      } finally {
        starting = false;
      }
      return;
    }
    if (p === '/api/session/stop' && req.method === 'POST') {
      // Don't race an in-flight start: wait for it to finish assigning `managed`
      // (bounded; the spawn itself is fast).
      for (let i = 0; i < 50 && starting; i++) await new Promise(r => setTimeout(r, 100));
      if (managed) {
        await stopManagedSession(managed);
        // the 'exit' handler clears `managed` and the pid file
      } else {
        // No in-memory handle (e.g. hub restarted): stop via the pid file —
        // but verify the PID is really our child first. A recycled PID must
        // never be signaled (precedent: pidIsDaemonProcess()).
        const info = readSessionPidFile();
        if (info) {
          const identity = pidIsManagedSession(info.pid, BIN_PATH);
          // null + live pid: /proc unavailable (non-Linux) → existence
          // check only (documented platform limitation in session.js).
          const unverifiable = identity === null && pidIsAlive(info.pid);
          if (identity === true || unverifiable) {
            try { process.kill(info.pid, 'SIGINT'); } catch { /* already gone */ }
            for (let i = 0; i < 40 && pidIsAlive(info.pid); i++)
              await new Promise(r => setTimeout(r, 250));
            // Re-verify before SIGKILL: the PID may have been recycled
            // while we waited for graceful shutdown.
            const still = pidIsManagedSession(info.pid, BIN_PATH);
            if (still === true || (still === null && unverifiable && pidIsAlive(info.pid))) {
              try { process.kill(info.pid, 'SIGKILL'); } catch { /* already gone */ }
            }
          }
          // identity === false → foreign/recycled PID: never signal.
        }
        clearSessionPidFile();
      }
      sendJSON(res, { ok: true }); return;
    }
    if (p === '/api/session/status' && req.method === 'GET') {
      sendJSON(res, sessionStatus()); return;
    }
    if (p === '/api/events' && req.method === 'GET') {      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      res.write(`event: snapshot\ndata: ${JSON.stringify(await snapshot())}\n\n`);
      const iv = setInterval(async () => {
        try { res.write(`event: snapshot\ndata: ${JSON.stringify(await snapshot())}\n\n`); }
        catch { clearInterval(iv); clients.delete(res); }
      }, 60_000);
      req.on('close', () => { clearInterval(iv); clients.delete(res); });
      return;
    }

    // ---- static ----
    let file = p === '/' ? '/index.html' : decodeURIComponent(p);
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      sendJSON(res, { error: 'not-found' }, 404); return;
    }
    const body = fs.readFileSync(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'content-length': body.length });
    res.end(body);
    } catch (e) {
      // Never leak stack traces or internal paths in the response body.
      console.error('hub request failed:', e?.message || e);
      if (res.headersSent || res.writableEnded) { try { res.destroy(); } catch {} return; }
      try { sendJSON(res, { error: 'internal-error' }, 500); } catch { try { res.destroy(); } catch {} }
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, listen, resolve);
  });
  const url = `http://${listen}:${port}/?token=${token}`;
  console.log(`agy hub listening on http://${listen}:${port}`);
  console.log(`token: ${token.slice(0, 8)}… (full token in ~/.agy-sandbox/hub-token)`);
  if (listen !== '127.0.0.1' && listen !== 'localhost')
    console.warn('WARNING: hub is listening on a non-localhost interface. Prefer Tailscale over public exposure.');
  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
  return { server, url, broadcast, snapshot };
}
