// P1 supervisor: owns one `docker exec` child running agy, tails its output,
// and exposes graceful stop. rotateOnce implements verify → handoff → respawn.
import { spawn as defaultSpawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildHandoff, writeHandoff } from './handoff.js';
import { nextRotationAllowed } from './rotate.js';
import { pickNearestResetAccount, waitUntilWake, consumeCancelFile } from './wait.js';

export class SupervisedSession {
  constructor({ spawnFn = defaultSpawn } = {}) {
    this.spawnFn = spawnFn;
    this.child = null;
    this.handlers = { output: [], line: [], exit: [] };
    this.buffers = { stdout: '', stderr: '' };
    this.exited = false;
  }
  on(event, cb) {
    if (!this.handlers[event]) throw new Error(`unknown event: ${event}`);
    this.handlers[event].push(cb);
    return this;
  }
  emit(event, arg) { for (const cb of this.handlers[event]) { try { cb(arg); } catch {} } }
  start(cmd, args = [], opts = {}) {
    if (this.child) throw new Error('session already started');
    const child = this.spawnFn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    this.child = child;
    for (const stream of ['stdout', 'stderr']) {
      child[stream]?.on('data', d => {
        const text = String(d);
        this.emit('output', { stream, data: text });
        this.buffers[stream] += text;
        const parts = this.buffers[stream].split('\n');
        this.buffers[stream] = parts.pop();
        for (const line of parts) this.emit('line', line);
      });
    }
    child.on('exit', (code, signal) => { this.exited = true; this.emit('exit', { code, signal }); });
    child.on('error', err => this.emit('exit', { code: null, signal: null, error: err?.message }));
    return this;
  }
  write(data) { this.child?.stdin?.write(data); }
  isRunning() { return !!this.child && !this.exited; }
  /** Pipe a readable (e.g. process.stdin) into the child's stdin for interactivity. */
  forwardStdin(source) {
    try { if (source?.readable) source.pipe(this.child.stdin); } catch {}
    return this;
  }
  /** Graceful stop: ask agy to exit, wait, then SIGTERM. Resolves when exited. */
  async gracefulStop(timeoutMs = 5000) {
    if (!this.child || this.exited) return;
    const done = new Promise(resolve => this.on('exit', resolve));
    try { this.child.stdin?.write('/exit\n'); } catch {}
    const timer = setTimeout(() => { try { this.child?.kill('SIGTERM'); } catch {} }, timeoutMs);
    await done;
    clearTimeout(timer);
  }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        v => ({ ok: true, value: v }),
        e => ({ ok: false, reason: 'error', error: e?.message }),
      ),
      new Promise(res => { timer = setTimeout(() => res({ ok: false, reason: 'timeout' }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Resolves on child exit, on the first output line (session is alive and
// talking), or on timeout (null). Lets a healthy resume skip the grace wait.
function waitForSettled(session, ms) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => finish(null), ms);
    function finish(info) {
      if (done) return; done = true;
      clearTimeout(timer); resolve(info);
    }
    try {
      session.on('exit', info => finish(info || { code: null }));
      session.on('line', () => finish({ code: 0, settled: 'output' }));
    } catch { finish(null); }
  });
}

function handoffMessage(h) {
  const todos = (h.pendingTodos || []).join(', ') || 'không có';
  return `Tiếp tục công việc từ handoff (account cũ: ${h.fromAccount}):\n${h.summary}\nTodos còn lại: ${todos}`;
}

/**
 * rotateOnce({session, activeAccount, accounts, getQuota, policy, rotState,
 *   handoffDir, now, spawnFor})
 * => {to, resumeMode, sessionId, session} | {exhausted:true} | {kept:true, reason}
 *
 * Ruling (pre-flight extension): also returns the new session so the caller
 * can reattach its watcher. Candidates are verified lazily in order (stops at
 * the first with quota) instead of pre-fetching every quota for
 * selectNextAccount — fewer `docker exec` calls, identical order semantics.
 */
export async function rotateOnce({ session, activeAccount, accounts = [], getQuota, policy = {}, rotState = {}, handoffDir, now = Date.now(), spawnFor }) {
  const allowed = nextRotationAllowed({
    rotationsThisSession: rotState.rotationsThisSession || 0,
    lastRotationAt: rotState.lastRotationAt || 0, policy, now,
  });
  if (!allowed.allowed) return { kept: true, reason: allowed.reason };

  const verifyMs = (policy.verifyTimeoutSec ?? 20) * 1000;
  const v = await withTimeout(getQuota(activeAccount.name), verifyMs);
  if (!v.ok) return { kept: true, reason: 'verify-failed' };
  const b5 = (v.value?.buckets || []).find(b => b.window === '5h');
  if (!b5 || b5.remainingFraction > 0) return { kept: true, reason: 'not-exhausted' };

  // Candidate order: policy.order first, then any registered accounts not
  // listed (same semantics as selectNextAccount in lib/rotate.js).
  const orderPref = policy.order?.length ? policy.order : [];
  const regNames = accounts.map(a => a.name);
  const order = [...orderPref.filter(n => regNames.includes(n)), ...regNames.filter(n => !orderPref.includes(n))];
  const notBefore = rotState.notBefore instanceof Map ? rotState.notBefore : new Map();

  const handoff = buildHandoff({
    sessionId: rotState.sessionId || '', fromAccount: activeAccount.name,
    cwd: rotState.cwd || '', gitHead: rotState.gitHead || '', gitDirty: rotState.gitDirty || [],
    summary: rotState.summary || '', pendingTodos: rotState.pendingTodos || [],
    interruptedTool: rotState.interruptedTool || null, now,
  });
  writeHandoff(handoffDir, handoff);
  await session.gracefulStop();

  // Try candidates in order; a spawn failure moves to the next candidate
  // instead of stranding the user with no session.
  let chosen = null;
  for (const name of order) {
    if (name === activeAccount.name) continue;
    if ((notBefore.get(name) || 0) > now) continue;
    const acc = accounts.find(a => a.name === name);
    if (!acc) continue;
    const qv = await withTimeout(getQuota(name), verifyMs);
    if (!qv.ok) continue;
    const qb = (qv.value?.buckets || []).find(b => b.window === '5h');
    if (!qb || qb.remainingFraction <= 0) continue;
    const attempt = await trySpawnCandidate(spawnFor, acc, handoff, handoffDir, policy);
    if (!attempt) continue;
    chosen = { acc, ...attempt };
    break;
  }
  if (!chosen) return { exhausted: true };

  rotState.rotationsThisSession = (rotState.rotationsThisSession || 0) + 1;
  rotState.lastRotationAt = now;
  // handoff already re-written with resumeMode by trySpawnCandidate
  return { to: chosen.acc.name, resumeMode: chosen.resumeMode, sessionId: handoff.sessionId, session: chosen.newSession };
}

/**
 * trySpawnCandidate(spawnFor, account, handoff, handoffDir, policy) =>
 *   {newSession, resumeMode} | null
 * Shared by rotateOnce and enterWaitingReset: native `--resume` first,
 * handoff-inject fallback when the resume exits non-zero. Null when the
 * candidate cannot be started at all (caller tries the next one).
 */
async function trySpawnCandidate(spawnFor, acc, handoff, handoffDir, policy) {
  let newSession;
  try {
    newSession = spawnFor(acc, ['--resume', handoff.sessionId]);
  } catch { return null; }
  let resumeMode = 'native';
  const early = await waitForSettled(newSession, policy.resumeGraceMs ?? 3000);
  if (early && early.code !== 0) {
    try {
      newSession = spawnFor(acc, []);
      newSession.write(handoffMessage(handoff) + '\n');
      resumeMode = 'handoff-inject';
    } catch { return null; }
  }
  if (handoffDir) writeHandoff(handoffDir, { ...handoff, resumeMode });
  return { newSession, resumeMode };
}

function writeStateFile(stateFile, state, now = Date.now()) {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: now }));
  fs.renameSync(tmp, stateFile);
}

/**
 * enterWaitingReset({accounts, getQuota, policy, rotState, handoffDir,
 *   spawnFor, stateFile, cancelFile, onTick, clock, now})
 * => {resumed:true, account, session, resumeMode} | {cancelled:true} | {givenUp:true}
 *
 * P2: all accounts exhausted → pick nearest reset, hold on (state file for
 * observability), sleep until resetAt + buffer, then RE-VERIFY quota (never
 * trust the timer — the machine may have slept) and respawn. Still exhausted
 * → recompute, up to maxWaitCycles.
 */
export async function enterWaitingReset({ accounts = [], getQuota, policy = {}, rotState = {},
  handoffDir, spawnFor, stateFile, cancelFile, onTick, onPick, clock, now = Date.now() }) {
  const verifyMs = (policy.verifyTimeoutSec ?? 20) * 1000;
  const recheckMs = (policy.waitRecheckSec ?? 300) * 1000;
  const bufferMs = (policy.resetBufferSec ?? 90) * 1000;
  const maxCycles = policy.maxWaitCycles ?? 5;
  const clk = clock || { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) };

  const gather = async () => {
    const quotas = new Map();
    for (const a of accounts) {
      const qv = await withTimeout(getQuota(a.name), verifyMs);
      if (qv.ok && qv.value && !qv.value.error) quotas.set(a.name, qv.value);
    }
    return quotas;
  };

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    let quotas = await gather();
    let pick = pickNearestResetAccount(accounts, quotas);
    for (let r = 0; r < 3 && !pick; r++) {
      // Sleep in slices so a cancel request is honored promptly instead of
      // being delayed until the full recheck interval elapses.
      const until = clk.now() + recheckMs;
      let cancelled = false;
      while (clk.now() < until) {
        if (consumeCancelFile(cancelFile)) { cancelled = true; break; }
        await clk.sleep(Math.min(5000, Math.max(0, until - clk.now())));
      }
      if (cancelled) return { cancelled: true };
      quotas = await gather();
      pick = pickNearestResetAccount(accounts, quotas);
    }
    if (!pick) return { givenUp: true };

    const wakeAt = pick.resetAt + bufferMs;
    writeStateFile(stateFile, { phase: 'waiting', account: pick.account.name, window: pick.window, wakeAt }, clk.now());
    onPick?.({ account: pick.account.name, window: pick.window, wakeAt });
    const w = await waitUntilWake({ wakeAt, cancelFile, pollMs: 5000, onTick, clock: clk });
    if (w.cancelled) return { cancelled: true };

    // Post-wake re-verify: the timer may have drifted (sleep/hibernate) or
    // the reset may have moved — only confirmed quota resumes the session.
    const qv = await withTimeout(getQuota(pick.account.name), verifyMs);
    const qb = qv.ok ? (qv.value?.buckets || []).find(b => b.window === '5h') : null;
    if (qb && qb.remainingFraction > 0) {
      const handoff = buildHandoff({
        sessionId: rotState.sessionId || '', fromAccount: pick.account.name,
        cwd: rotState.cwd || '', gitHead: rotState.gitHead || '', gitDirty: rotState.gitDirty || [],
        summary: rotState.summary || '', pendingTodos: rotState.pendingTodos || [],
        interruptedTool: rotState.interruptedTool || null, now,
      });
      const attempt = await trySpawnCandidate(spawnFor, pick.account, handoff, handoffDir, policy);
      if (attempt) {
        writeStateFile(stateFile, { phase: 'active', account: pick.account.name }, clk.now());
        return { resumed: true, account: pick.account.name, session: attempt.newSession, resumeMode: attempt.resumeMode };
      }
    }
    // still exhausted (or spawn failed) → loop recomputes the nearest reset
  }
  return { givenUp: true };
}

/**
 * getGitInfo(dir) => {gitHead, gitDirty[]} — best-effort repo snapshot for
 * handoffs. Returns empty values (never throws) outside a git repo.
 */
export function getGitInfo(dir) {
  if (!dir) return { gitHead: '', gitDirty: [] };
  try {
    const opts = { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] };
    const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
    const out = execFileSync('git', ['status', '--porcelain'], opts).trim();
    return { gitHead, gitDirty: out ? out.split('\n') : [] };
  } catch { return { gitHead: '', gitDirty: [] }; }
}

// ---- per-account locks (Task 6) ----
// Prevents two supervisors from owning the same account's session.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

/** acquireLock(root, name) => {ok:true} | {ok:false, pid} — clears stale locks. */
export function acquireLock(root, name) {
  const dir = path.join(root, 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur?.pid && pidAlive(cur.pid)) return { ok: false, pid: cur.pid };
    try { fs.unlinkSync(file); } catch {} // stale lock
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    // 'wx' closes the check-then-write race: two supervisors starting the
    // same millisecond cannot both win.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { ok: false, pid: 'unknown' };
  }
  return { ok: true };
}

export function releaseLock(root, name) {
  try { fs.unlinkSync(path.join(root, 'locks', `${name}.json`)); } catch {}
}
