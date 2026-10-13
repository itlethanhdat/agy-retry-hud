// agybox supervisor bus client (P3-3).
//
// DELIBERATE DUPLICATION: the three helpers below mirror
// agybox/lib/config.js (sandboxRoot) and agybox/lib/supervisor.js
// (supervisorActive, requestRotate). They are NOT imported from agybox/
// because plugin/agy-retry-hud/dist is a verbatim copy of src/ — a static
// cross-boundary relative import would resolve to plugin/agybox/... at
// runtime and break the installed plugin. Keep the file formats in sync
// with the agybox originals if they ever change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function agyboxSandboxRoot() {
  return process.env.AGYBOX_ROOT || path.join(os.homedir(), '.agy-sandbox');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

/** agyboxSupervisorActive(root) => true when any account lock is held by a live pid. */
export function agyboxSupervisorActive(root) {
  let files = [];
  try { files = fs.readdirSync(path.join(root, 'locks')); } catch { return false; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(root, 'locks', f), 'utf8'));
      if (cur?.pid && pidAlive(cur.pid)) return true;
    } catch {}
  }
  return false;
}

const ROTATE_REQUEST_FILE = 'rotate-request.json';

/**
 * agyboxRequestRotate(root, {to, source}={}) — signal a running agybox
 * supervisor to rotate. Atomic write; the supervisor consumes it one-shot.
 */
export function agyboxRequestRotate(root, { to = null, source = 'daemon' } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `${ROTATE_REQUEST_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ to, requestedAt: Date.now(), source }));
  fs.renameSync(tmp, path.join(root, ROTATE_REQUEST_FILE));
}
