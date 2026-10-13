// Docker helpers. Graceful when docker is not installed.
import { spawnSync } from 'node:child_process';

let cached = null;
export function dockerAvailable() {
  if (cached !== null) return cached;
  try {
    const r = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 });
    cached = r.status === 0;
  } catch { cached = false; }
  return cached;
}

/**
 * resetDockerCache() — clears the dockerAvailable() cache so the next call
 * re-probes. The hub's "re-check" button calls this via ?fresh=1, so a Docker
 * installed while the hub is running is picked up without a restart.
 */
export function resetDockerCache() { cached = null; }

export function dockerExec(container, args, { timeout = 30000 } = {}) {
  if (!dockerAvailable()) return { ok: false, error: 'docker-unavailable' };
  try {
    const r = spawnSync('docker', ['exec', container, ...args], { encoding: 'utf8', timeout });
    return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function containerRunning(name) {
  if (!dockerAvailable()) return false;
  try {
    const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 && r.stdout.trim() === 'true';
  } catch { return false; }
}
