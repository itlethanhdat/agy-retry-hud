# Execution ledger — Revision 3.1 / 0.2.1

Date: 2026-09-30.

## Architecture rulings

- Revision 2's separate wrapper HUD is superseded as primary UX.
- Revision 3 primary UX: native `agy` TUI + custom status line + plugin Stop hook + detached exact-conversation worker.
- PTY/ConPTY/keystroke injection remains rejected.
- Stop hook never sleeps for retry delay because hook execution is bounded; it schedules only.
- Existing headless stream adapter/policy/quota/state code is reused by the background worker.
- Wrapper remains fallback/demo/diagnostic.
- Node.js 24 ESM standard library remains release runtime; no runtime npm dependency.

## Workstream status

- WS0 research: complete for documented contracts; authenticated live fixtures pending external gate.
- WS1 stream adapter: offline complete; live conformance pending.
- WS2 classifier/policy: complete.
- WS3 state/lock/scheduler: complete.
- WS4 supervisor/wrapper core: complete.
- WS5 config/offline release: complete; hosted/macOS/Windows/live gates pending.
- WS6 quota provider: offline complete; live `/usage` provider schema pending.
- WS7 wrapper HUD/session continuity: complete and retained as fallback.
- WS8 native integration: code/offline complete; live plugin/statusline/hook smoke pending.
- WS9 docs/final offline validation/archive: complete in this delivery; stable label blocked by live gates.

## Native review fixes during this pass

1. Separated statusline telemetry from retry state to prevent redraw/state races.
2. Deduplicated repeated Stop incidents.
3. Made normal native Stop cancel a pending retry after manual continuation.
4. Reloaded fresh telemetry before background dispatch; native agent activity/pending input/tool confirmation cancels dispatch.
5. Validated exact conversation ID and canonical workspace before continuation send.
6. Ignored worker-originated Stop hook scheduling to prevent recursion.
7. Installer preserves unrelated AGY settings and restores previous custom status line.
8. Packaged plugin entry is exercised directly in subprocess tests.
9. Status HUD shows both countdown and absolute UTC retry time because native statusline is event-driven rather than guaranteed 1 Hz.
10. Statusline telemetry deliberately excludes email/plan-tier/credentials from persistence.
11. Release plugin hook command self-resolves the standard Antigravity global plugin roots; direct `agy plugin install` no longer requires placeholder rewriting.
12. Added safe `verify:live` probes that do not execute model turns.

## Final offline evidence

- `node --test test/*.test.js`: **53 passed, 0 failed, 0 skipped**.
- `node src/cli.js demo --plain`: simulated 503 -> wait -> one same-conversation retry -> SUCCEEDED.
- Syntax checks for source, installer and packaged plugin dist: PASS.
- Installer tests confirm the auto-wired absolute hook path and direct-install release hook both have no unresolved placeholder; the direct release hook is executed in a staged global-plugin layout.

## External gates intentionally not marked complete

- authenticated AGY binary/account unavailable in the sandbox;
- no live Linux statusline/plugin hook capture;
- hosted Node 24 matrix not executed here;
- macOS/Windows live smoke not executed here;
- no natural quota recovery fixture.

These are release-evidence debts. They do not justify claiming a stable release yet.
