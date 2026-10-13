// Config + account registry + workspace mapping validation. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sandboxRoot() {
  return process.env.AGYBOX_ROOT || path.join(os.homedir(), '.agy-sandbox');
}
export function accountsDir() { return path.join(sandboxRoot(), 'accounts'); }
function configFile() { return path.join(sandboxRoot(), 'config.json'); }
function accountsFile() { return path.join(sandboxRoot(), 'accounts.json'); }

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULT_CONFIG = {
  version: 1,
  workspaces: [
    { name: 'main', hostPath: '~/workspace', containerPath: '/workspace', mode: 'rw', scope: 'global' },
  ],
  rotation: {
    order: [], maxRotationsPerSession: 8, rotationCooldownSec: 30,
    verifyTimeoutSec: 20, resetBufferSec: 90, waitRecheckSec: 300,
  },
  hub: { port: 8765 },
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSONAtomic(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...readJSON(configFile(), {}) };
  cfg.workspaces = Array.isArray(cfg.workspaces) ? cfg.workspaces : [...DEFAULT_CONFIG.workspaces];
  cfg.rotation = { ...DEFAULT_CONFIG.rotation, ...(cfg.rotation || {}) };
  cfg.hub = { ...DEFAULT_CONFIG.hub, ...(cfg.hub || {}) };
  return cfg;
}
export function saveConfig(cfg) { writeJSONAtomic(configFile(), cfg, 0o600); }

export function loadAccounts() {
  const data = readJSON(accountsFile(), { accounts: [] });
  return Array.isArray(data.accounts) ? data.accounts : [];
}
export function saveAccounts(accounts) { writeJSONAtomic(accountsFile(), { accounts }, 0o600); }

/** Validate one workspace mapping. Returns {ok, errors[]}. */
export function validateWorkspaceMapping(m, accounts = []) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['mapping must be an object'] };
  if (!m.name || typeof m.name !== 'string') errors.push('name is required');
  const hostPath = expandHome(m.hostPath);
  if (!m.hostPath || typeof m.hostPath !== 'string') errors.push('hostPath is required');
  else {
    let st;
    try { st = fs.statSync(hostPath); } catch { st = null; }
    if (!st) errors.push(`hostPath does not exist: ${m.hostPath}`);
    else if (!st.isDirectory()) errors.push(`hostPath is not a directory: ${m.hostPath}`);
  }
  if (!m.containerPath || !path.posix.isAbsolute(m.containerPath))
    errors.push('containerPath must be an absolute posix path');
  if (!['rw', 'ro'].includes(m.mode)) errors.push("mode must be 'rw' or 'ro'");
  if (m.scope === 'global') { /* fine */ }
  else if (typeof m.scope === 'string' && m.scope.startsWith('account:')) {
    const name = m.scope.slice('account:'.length);
    if (!accounts.some(a => a.name === name)) errors.push(`scope account does not exist: ${name}`);
  } else errors.push("scope must be 'global' or 'account:<name>'");
  // Warn (not fail) on sensitive host paths.
  const sensitive = ['~/.ssh', '~/.gnupg', '/etc', '/root'];
  const norm = hostPath || '';
  for (const s of sensitive) {
    const full = expandHome(s);
    if (norm === full || norm.startsWith(full + path.sep)) { errors.push(`warning: hostPath looks sensitive: ${m.hostPath}`); break; }
  }
  return { ok: errors.length === 0, errors };
}

export function listWorkspaceMappings(cfg = loadConfig()) { return cfg.workspaces; }

/** Volume args for `docker run` derived from mappings applicable to an account. */
export function volumeArgsFor(accountName, cfg = loadConfig()) {
  const accounts = loadAccounts();
  const out = [];
  for (const m of cfg.workspaces) {
    if (m.scope !== 'global' && m.scope !== `account:${accountName}`) continue;
    const v = validateWorkspaceMapping(m, accounts);
    if (!v.ok) continue; // skip invalid rather than breaking container creation
    out.push('-v', `${expandHome(m.hostPath)}:${m.containerPath}${m.mode === 'ro' ? ':ro' : ''}`);
  }
  return out;
}
