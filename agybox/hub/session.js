// Hub-managed supervised session (H1-3).
// Spawns `node bin/agybox run` as a child process so the hub reuses the full
// supervisor (auto-rotate, WAITING_RESET) instead of reimplementing it.
// No dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** pidIsAlive(pid) => true when a process with that pid exists. */
export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * pidIsManagedSession(pid, binPath) => true | false | null.
 * Verifies /proc/<pid>/cmdline looks like our `node <binPath> run ...` child
 * (precedent: pidIsDaemonProcess() in src/daemon.js — never signal a pid
 * without verifying its identity, PIDs get recycled by the OS).
 * - true:  verified to be our managed child — safe to signal.
 * - false: verified NOT ours (recycled/foreign PID) — never signal.
 * - null:  identity could not be verified. On Linux a live pid always yields
 *           true/false, so null + alive pid means /proc is unavailable
 *           (non-Linux): callers fall back to the existence check only, and
 *           this platform limitation is documented here. Callers must be
 *           conservative: never signal when identity can't be verified,
 *           unless they explicitly accept the fallback.
 */
export function pidIsManagedSession(pid, binPath) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); }
  catch { return null; }
  const argv = raw.split('\0');
  const script = argv[1] || '';
  const isOurs = (script === binPath || script.endsWith('/bin/agybox') || script.endsWith('\\bin\\agybox'))
    && argv.slice(2).includes('run');
  return isOurs;
}

/** Split stream chunks into lines; calls onLine for each complete line. */
function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  };
}

/**
 * startManagedSession({account, binPath, env, onLog, maxLog=500})
 * => {proc, account, startedAt, log[], spawnError}.
 * Spawns `node <binPath> run [--account <name>]` with piped stdio; appends
 * each output line to `log` (capped) and calls `onLog(line)`.
 */
export async function startManagedSession({ account, binPath, env, onLog, maxLog = 500 }) {
  const args = ['run'];
  if (account) args.push('--account', account);
  const proc = spawn(process.execPath, [binPath, ...args], {
    env: { ...env },
    // stdin MUST be an open pipe, never 'ignore': the supervised `agy`
    // sees instant EOF on a closed stdin and exits right away. The hub never
    // writes to it; the pipe just stays open so the session stays alive.
    // (If the hub dies, the pipe closes, but the supervisor never reads
    // stdin, so EOF does NOT stop it — pid-file recovery in server.js is
    // the real orphan mechanism.)
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const handle = { proc, account: account || null, startedAt: Date.now(), log: [], spawnError: null };
  proc.on('error', (err) => { handle.spawnError = err; });
  const push = lineSplitter((line) => {
    handle.log.push(line);
    if (handle.log.length > maxLog) handle.log.splice(0, handle.log.length - maxLog);
    try { onLog?.(line); } catch { /* onLog must never break the session */ }
  });
  proc.stdout.on('data', push);
  proc.stderr.on('data', push);
  return handle;
}

/**
 * stopManagedSession(handle, {graceMs=10000}).
 * SIGINT first (the run process shuts down gracefully on SIGINT), SIGKILL
 * after graceMs. Resolves when the process is gone.
 */
export function stopManagedSession(handle, { graceMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const proc = handle.proc;
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(resolve, 1000).unref();
    }, graceMs);
    if (timer.unref) timer.unref();
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    try { proc.kill('SIGINT'); }
    catch { clearTimeout(timer); resolve(); }
  });
}
