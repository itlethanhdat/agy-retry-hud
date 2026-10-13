// agy hub — local web management UI (H0: read-only).
// Serves SPA + JSON API + SSE. Token auth, binds localhost by default.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sandboxRoot, loadConfig } from '../lib/config.js';
import { refreshAllQuotas } from '../lib/accounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');

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

export async function startHub({ port = 8765, open = false, listen = '127.0.0.1' } = {}) {
  const token = getHubToken();
  const clients = new Set();

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
  }
  async function snapshot() {
    return { ts: Date.now(), accounts: refreshAllQuotas(), config: { workspaces: loadConfig().workspaces } };
  }

  const server = http.createServer(async (req, res) => {
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
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
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
