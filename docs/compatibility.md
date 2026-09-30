# Compatibility and evidence — v0.4.0

Date: 2026-09-30

## Runtime contract

- Node.js: **24.x** release contract.
- Known AGY target used for v0.4 product decisions: **Antigravity CLI 1.2.14**.
- Headless stream minimum retained by the existing adapter: **1.1.15**.
- Capability detection remains more important than version string alone.

Required AGY capabilities:

- plugin install/discovery;
- plugin skills;
- plugin Stop hook;
- custom status line;
- headless JSON/stream conversation support;
- exact conversation IDs;
- context/quota telemetry used by the HUD.

## Platform target

- Linux
- macOS
- Windows

CI is configured for Node 24.21.0 on all three OS. A configured matrix is not treated as proof that hosted CI or live AGY integration actually ran.

## Current execution environment

The final build sandbox used for offline verification exposes Node v22.16.0 and no `agy` executable. Therefore:

- automated source/artifact regression evidence is valid as offline evidence;
- Node 24 runtime remains an external release gate in this sandbox;
- authenticated AGY behavior remains an external release gate;
- natural quota recovery is not fabricated.

## Conservative compatibility behavior

- Missing/unknown weekly quota before a quota retry cannot be guessed healthy.
- Unknown error/protocol/tool outcome stops automatic retry.
- Plugin startup before a conversation ID exists renders ephemerally and does not persist invalid session state.
- Existing foreign custom status line is preserved unless force replacement is explicit.
- Imported `.agyh` is validated before extraction/continuation.

## Live checklist

Run `npm run verify:live` first; it only performs read-only probes.

- [ ] Node 24 execution on target machine.
- [ ] `agy --version` / capability probe.
- [ ] plugin listed.
- [ ] `/hooks` sees retry hook.
- [ ] `/skills` sees five v0.4 skills.
- [ ] native HUD visual smoke.
- [ ] global/session retry controls in real TUI.
- [ ] manual handoff and continue-handoff in real TUI.
- [ ] natural 5h/weekly quota behavior when encountered.
- [ ] Linux live worker/rollover smoke.
- [ ] macOS live smoke.
- [ ] Windows live smoke.
