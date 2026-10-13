// Setup steps with honest capability detection (H2-2).
//
// Each step: {id, label, check(ctx) => {ok, detail, manual?}, run?}.
// `run: null` means check-only — the UI shows `manual` instructions instead
// of pretending a one-click fix exists. Every ctx field is injectable so
// tests stub docker; defaults are the real implementations.
//
// ctx: {dockerAvailable, sh(cmd,args)=>{status,stdout,stderr}, home (string),
//       listAccounts, dryRun}. `sh` never interpolates user text — container
// names travel as argv entries, never inside a shell string (AGENTS.md).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerAvailable as realDockerAvailable } from './docker.js';
import { listAccounts as realListAccounts } from './accounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function realSh(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
    return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { status: 1, stdout: '', stderr: String(e?.message || e) };
  }
}

const realCtx = {
  dockerAvailable: realDockerAvailable,
  sh: realSh,
  home: os.homedir(),
  listAccounts: realListAccounts,
  dryRun: false,
};

/** Merge injected ctx over real defaults. */
function withDefaults(ctx = {}) {
  return { ...realCtx, ...ctx };
}

// HUD plugin locations inside a container, mirroring src/setup.js
// setupPaths()/locateInstalledPlugin(): the shared config path (AGY 1.0.2+)
// is preferred, the CLI-private path is accepted. `~` needs a shell, so the
// probe runs under `sh -c`; container name stays an argv entry.
const PLUGIN_PROBE = 'test -f ~/.gemini/config/plugins/agy-retry-hud/plugin.json || test -f ~/.gemini/antigravity-cli/plugins/agy-retry-hud/plugin.json';

function unitFileContent() {
  const bin = path.resolve(here, '..', 'bin', 'agybox');
  return `[Unit]
Description=agybox hub — multi-account AGY management UI
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${bin} hub
Restart=on-failure
RestartSec=10
Environment=AGYBOX_ROOT=%h/.agy-sandbox

[Install]
WantedBy=default.target
`;
}

function unitPath(home) {
  return path.join(home, '.config', 'systemd', 'user', 'agybox-hub.service');
}

export const SETUP_STEPS = [
  {
    id: 'docker-check',
    label: 'Docker installed',
    run: null,
    check: async (ctx = {}) => {
      const { dockerAvailable, sh } = withDefaults(ctx);
      if (!dockerAvailable()) {
        return {
          ok: false,
          detail: 'docker not found on this machine',
          manual: [
            'Install Docker: https://docs.docker.com/get-docker/ (Desktop) or your distro package, then start the daemon.',
          ],
        };
      }
      const r = sh('docker', ['--version']);
      const ver = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : 'docker';
      return { ok: true, detail: `${ver} is available` };
    },
  },
  {
    id: 'image-check',
    label: 'agybox image present',
    run: null,
    check: async (ctx = {}) => {
      const { dockerAvailable, sh } = withDefaults(ctx);
      if (!dockerAvailable()) {
        return {
          ok: false,
          detail: 'docker unavailable — cannot check the image',
          manual: ['Install and start Docker first (see the docker-check step).'],
        };
      }
      const r = sh('docker', ['images', '-q', 'agybox:latest']);
      if (r.status === 0 && r.stdout.trim()) {
        return { ok: true, detail: 'image agybox:latest is present' };
      }
      return {
        ok: false,
        detail: 'image agybox:latest not found',
        manual: [
          'No Dockerfile is shipped in this repo yet — build the image from the layout described in agybox/DESIGN-rotation.md, then tag it agybox:latest.',
        ],
      };
    },
  },
  {
    id: 'plugin-check',
    label: 'HUD plugin installed in containers',
    run: null,
    check: async (ctx = {}) => {
      const { dockerAvailable, sh, listAccounts } = withDefaults(ctx);
      if (!dockerAvailable()) {
        return {
          ok: false,
          detail: 'docker unavailable — cannot probe containers',
          manual: ['Install and start Docker first (see the docker-check step).'],
        };
      }
      const accounts = listAccounts();
      if (!accounts.length) {
        return {
          ok: false,
          detail: 'no accounts registered',
          manual: ['Add an account first: `agybox add <name>`.'],
        };
      }
      const missing = [];
      for (const a of accounts) {
        const container = a.container || `agy-${a.name}`;
        const r = sh('docker', ['exec', container, 'sh', '-c', PLUGIN_PROBE]);
        if (r.status !== 0) missing.push(a.name);
      }
      if (!missing.length) {
        return { ok: true, detail: `HUD plugin present in ${accounts.length} container(s)` };
      }
      return {
        ok: false,
        detail: `HUD plugin missing in container(s): ${missing.join(', ')}`,
        manual: [
          'Copy plugin/agy-retry-hud into each container home (~/.gemini/...) and wire it — see src/setup.js installAndWire for the exact layout — then re-run this check.',
        ],
      };
    },
  },
  {
    id: 'autostart',
    label: 'Autostart hub on login',
    check: async (ctx = {}) => {
      const { home } = withDefaults(ctx);
      if (fs.existsSync(unitPath(home))) {
        return { ok: true, detail: 'agybox-hub.service is installed' };
      }
      return {
        ok: false,
        detail: 'agybox-hub.service is not installed',
        manual: [
          'Run this step to install the systemd user unit, then enable it: systemctl --user enable --now agybox-hub.service',
        ],
      };
    },
    run: async (ctx = {}) => {
      const { home, dryRun } = withDefaults(ctx);
      const dest = unitPath(home);
      if (dryRun) return { detail: `would write ${dest}`, dryRun: true };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, unitFileContent(), { mode: 0o644 });
      return {
        detail: `wrote ${dest}; enable it with: systemctl --user enable --now agybox-hub.service (systemctl is never run automatically)`,
      };
    },
  },
];
