// Account registry + per-account quota refresh. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { accountsDir, loadAccounts, saveAccounts } from './config.js';
import { dockerAvailable, dockerExec, containerRunning } from './docker.js';
import { parseUsagePayload, nearestResetAt } from './quota.js';

const QUOTA_TTL_MS = 60_000;
const quotaCache = new Map(); // name -> {at, result}

export { loadAccounts };
export function listAccounts() { return loadAccounts(); }
export function getAccount(name) { return loadAccounts().find(a => a.name === name) || null; }

function validName(name) { return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name); }

export function addAccount({ name, email = '' }) {
  if (!validName(name)) throw new Error(`invalid account name: ${name}`);
  const accounts = loadAccounts();
  if (accounts.some(a => a.name === name)) throw new Error(`account already exists: ${name}`);
  const home = path.join(accountsDir(), name);
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const acc = { name, email, container: `agy-${name}`, home, createdAt: Date.now() };
  accounts.push(acc); saveAccounts(accounts);
  return acc;
}

export function removeAccount(name) {
  const accounts = loadAccounts();
  const i = accounts.findIndex(a => a.name === name);
  if (i < 0) throw new Error(`unknown account: ${name}`);
  if (containerRunning(accounts[i].container))
    throw new Error(`container ${accounts[i].container} is running; stop it first`);
  accounts.splice(i, 1); saveAccounts(accounts);
  quotaCache.delete(name);
}

/** Refresh quota for one account via `agy -p /usage` inside its container. */
export function refreshAccountQuota(name, { force = false } = {}) {
  const acc = getAccount(name);
  if (!acc) return { name, error: 'unknown-account' };
  const cached = quotaCache.get(name);
  if (!force && cached && Date.now() - cached.at < QUOTA_TTL_MS) return { name, ...cached.result };
  let result;
  if (!dockerAvailable()) {
    result = { error: 'docker-unavailable', containerRunning: false };
  } else if (!containerRunning(acc.container)) {
    result = { error: 'container-down', containerRunning: false };
  } else {
    const r = dockerExec(acc.container, ['agy', '-p', '/usage', '--output-format', 'json'], { timeout: 25000 });
    if (!r.ok) result = { error: 'usage-failed', detail: (r.stderr || r.error || '').slice(0, 200), containerRunning: true };
    else {
      try {
        const parsed = parseUsagePayload(JSON.parse(r.stdout));
        result = {
          buckets: parsed.buckets, nearestResetAt: nearestResetAt(parsed.buckets),
          checkedAt: parsed.checkedAt, containerRunning: true,
        };
      } catch (e) { result = { error: 'usage-parse-failed', detail: e.message, containerRunning: true }; }
    }
  }
  const out = { name, container: acc.container, email: acc.email, ...result };
  quotaCache.set(name, { at: Date.now(), result: out });
  return out;
}

export function refreshAllQuotas({ force = false } = {}) {
  return loadAccounts().map(a => refreshAccountQuota(a.name, { force }));
}
