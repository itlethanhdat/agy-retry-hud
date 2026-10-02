# agy-retry-hud v0.5.0 — Test Report

Date: 2026-10-02

## Automated regression

- Total tests: **126**
- Passed: **126**
- Failed: **0**
- Skipped: **0**
- Test command: `npm test`

Coverage includes the existing retry/handoff/statusline suite plus v0.5 daemon singleton, adaptive polling, durable wait adoption, v0.4 incident migration, HUD modes, and local control-plane behavior.

## Plugin package verification

`npm run verify:plugin-package`:

- plugin root valid;
- 9 skills packaged;
- portable handoff schema v1 present;
- daemon runtime asset present.

## Daemon smoke

Local start/status/stop smoke succeeded:

- singleton process started;
- heartbeat became RUNNING;
- runtime session/wait/task counters were readable;
- graceful stop succeeded.

## Resource smoke (20 idle conversations)

Observed in the build container after warm-up:

- RSS: ~36 MB;
- 5-second sampled CPU: ~0.0% at idle;
- one daemon process for all 20 conversations.

This is an environment-specific smoke measurement, not a hard runtime guarantee.

## Cross-platform evidence

The existing suite retains synthetic Windows quoting/path tests and portable Linux/macOS/Windows path behavior. Live authenticated AGY execution on each OS remains separate from offline regression evidence.

## Known native-TUI limitation

The daemon owns retry deadlines independently of AGY redraws. Public AGY plugin hooks do not expose a safe background TUI repaint primitive, so a visible statusline can remain visually stale while the TUI is completely idle; scheduler/daemon health remains queryable via `agy-retryctl` and automatic retry does not require a HUD repaint.
