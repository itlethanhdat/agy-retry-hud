# v0.4.9

- Rebuilt retry HUD around explicit scheduler observability: `retry:WAIT <countdown> · <reason> · <attempt/max> · sched:<health>`.
- Added compact countdown formatting (`MM:SS`, `HH:MM:SS`, `Nd HH:MM`) so quota/API waits visibly tick down without external polling.
- Added sanitized retry reason labels such as `503`, `502`, `504`, `429`, `TIMEOUT`, `NET`, `API`, and `QUOTA`; full error text is not persisted for HUD display.
- Retry scheduler now persists worker PID, worker start, heartbeat, incident id, deadline source, retry reason, next deadline, and attempt budget.
- Detached retry worker heartbeats while waiting and records `CHECKING → DISPATCHING → RUNNING → DONE/CANCELED/BLOCKED/...` transitions.
- Added scheduler health evaluation: `OK`, `STALE`, `LOST`, `CHECK`, `DISPATCH`, `RUNNING`. `OK` requires a live worker PID plus a fresh heartbeat.
- Added `agy-retryctl retry scheduler [--conversation ID] [--json]` for local-only scheduler diagnostics; `retry status --json` now embeds the same scheduler block.
- Deadline sources are explicit: `server`, `telemetry-5h`, `fallback`, `server-delay`, or `backoff`.
- Existing quota safety, weekly block, incident-local stale-retry protection, manual supersede, and `MULTI_CLI` gates remain in force.
- Full offline suite: 113 tests.

# v0.4.8

- Fixed missed auto-retry for real AGY `Individual quota reached ... Resets in ...` errors when the Stop hook arrives with `fullyIdle=false`.
- Non-idle **normal** Stops are still deferred, but confirmed retryable quota/transient errors may now arm an incident immediately; the worker re-checks native activity before dispatch.
- Added a structured 5h-quota fallback for `terminationReason=error` when AGY omits `payload.error` but statusline telemetry shows the active 5h bucket exhausted with a future reset.
- Added `lastStop` diagnostics (`terminationReason`, `fullyIdle`, classification, classification source) to native state and `agy-retryctl retry status --json`.
- Added regression coverage for the exact production wording `Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h23m10s.` including Error ID, non-idle Stop, missing Stop error, and healthy-quota negative control.
- Full offline suite: 108 tests.

# v0.4.7

- Manual/new AGY `PreInvocation` now supersedes stale `NEEDS_USER`, `PAUSED_UNCERTAIN`, waiting, or dispatching retry state for the same conversation and clears `nextRetryAt` without disabling retry.
- Added `agy-retryctl retry clear [--conversation ID]` to invalidate only the current retry incident while preserving global/session retry policy.
- `agy-retryctl retry status --json` now reports `conversationResolution`, `multiCli`, and active terminal-instance count.
- Added terminal-instance binding before cwd fallback; tmux uses `TMUX_PANE`, with supported hints for Windows Terminal, WezTerm, Kitty, Terminal.app, GNOME Terminal, and Konsole.
- Added multi-CLI protection: if the same conversation is live in multiple terminal instances, retry becomes `MULTI_CLI` and background workers send zero model messages.
- Worker rechecks multi-CLI state at dispatch time, covering a duplicate CLI opened after a retry was already scheduled.
- Added regression coverage for exact tmux conversation resolution, manual supersede of NEEDS_USER/PAUSED_UNCERTAIN, retry clear, immediate multi-CLI block, and deadline-time multi-CLI block. Full offline suite: 104 tests.

# v0.4.6

- Fixed stale `PAUSED_UNCERTAIN` state after resuming a conversation that previously received a non-idle Stop while background/subagent work was active.
- `Stop + fullyIdle=false` now defers retry classification and does not create a retry incident or `PAUSED_UNCERTAIN`.
- Status-line telemetry self-heals the exact legacy v0.4.5 non-idle Stop marker when the same conversation is resumed.
- `PreInvocation` also clears that legacy marker when a new turn starts.
- HUD now distinguishes genuine `retry:UNCERTAIN` from `retry:NEEDS USER`.
- `agy-retryctl retry status --json` now includes the native retry `reason`.
- Added regression coverage for resume-without-subagent, legacy-state self-healing, and HUD state separation. Full offline suite: 99 tests.

# v0.4.5

- Added **Stale Retry Protection / Retry Incident Lifecycle** so quota recovery in one conversation cannot wake unrelated or already-finished conversations.
- Every retryable Stop now creates a conversation-local `retryIncident` with a stable incident id, fingerprint, execution number, lifecycle status, and timestamps.
- Normal successful Stop automatically resolves the current incident (`RESOLVED`) and clears its retry deadline.
- Added a plugin-level `PreInvocation` hook. Any newer/manual AGY invocation supersedes (`SUPERSEDED`) a pending incident before the model turn proceeds.
- Detached workers now receive the exact `incidentId` they were created for and refuse to dispatch when that incident is no longer current (`STALE_RETRY`).
- Added a final incident check immediately before the background prompt is sent, including handoff rollover dispatches.
- Native activity detected before dispatch is treated as superseding the pending retry rather than as a reason to send another continuation.
- Added safety defaults `retry.autoDisarmIncidentOnSuccess=true` and `retry.requireCurrentIncidentBeforeDispatch=true`.
- HUD can briefly show `retry:RESOLVED`, `retry:SUPERSEDED`, and `retry:ARMED` to make the incident lifecycle observable.
- Added multi-session, stale-worker, PreInvocation, and cross-platform hook regression coverage. Full offline suite: 95 tests.

# v0.4.4

- Fixed AGY 1.2.14 global plugin-path detection on Windows/Linux/macOS. Current AGY installs may use the shared `~/.gemini/config/plugins/agy-retry-hud` location; setup no longer incorrectly rejects that location as "legacy".
- `setup install`, `setup doctor`, and `setup repair` now accept both supported AGY global plugin roots: shared config (`~/.gemini/config/plugins`) and CLI-private compatibility (`~/.gemini/antigravity-cli/plugins`).
- `setup doctor` now reports `installLocation`, `sharedConfigStaged`, `cliStaged`, and `skillsDiscoverable`; either supported global root can satisfy skill discovery.
- `setup repair` no longer attempts to move a healthy shared-config plugin into the CLI-private path.
- Preserved v0.4.3 compact two-line HUD as the default and retained six packaged skills including `/agy-retry-hud:setup`.
- Added regression coverage that simulates AGY 1.2.x installing the plugin under the shared config path. Full offline suite: 90 tests.

# v0.4.2

- HUD Wide grid: `ctx` and first quota bar/percentage columns are visually aligned.
- Semantic percentage colors: context 0-69 green, 70-84 yellow, 85-94 orange, 95-100 red; quota 70-100 green, 30-69 yellow, 10-29 orange, 0-9 red.
- 5h + weekly stay on one quota row when terminal width permits; reset formatting keeps `↻ <duration>` spacing.
- Added `/agy-retry-hud:setup` skill.
- Added `agy-retryctl setup status|repair` and deterministic setup repair for statusline, hooks, launcher and missing default config.
- Doctor now verifies six skills, Stop hook wiring, config health, schema and reinstall requirements.

# Changelog

## 0.4.2 - 2026-09-30

- Fix native Windows AGY 1.2.14 status-line startup when a quoted absolute Node script path is treated as a literal module argument and resolved relative to the current workspace.
- Windows status-line wiring now uses a PowerShell `-EncodedCommand` bridge, avoiding command-line quote/path splitting entirely and supporting user/profile paths containing spaces.
- The Windows bridge reads the raw status-line payload from stdin, forwards it to `native-entry.js statusline`, preserves stdout/stderr, and returns the Node exit code.
- Installed Stop-hook commands are rewritten through the same quote-safe Windows bridge.
- `doctor`, reinstall ownership detection, and uninstall recognize encoded commands by safely decoding the local command definition.
- Harden `hooks/status-line.ps1` to read stdin through `[Console]::In.ReadToEnd()` and propagate the child exit code.
- Add Windows path/space regression coverage; full offline suite is now 82 tests.

## 0.4.0 - 2026-09-30

- Add deterministic retry controls with global ON/OFF and per-conversation `inherit|on|off` overrides, including “retry only this session”.
- Add weekly quota hard gate (default safety threshold 1%): blocked weekly quota never dispatches an automatic model retry.
- Add one HandoffEngine shared by automatic context rollover and manual handoff creation.
- Add context policy: warning 80%, mechanical snapshot 85%, semantic handoff 90%, rollover 95%, and rollover cancellation below 80% after native compaction.
- Add portable versioned `.agyh` handoffs that do not depend on source absolute paths or source conversation IDs.
- Add Git workspace identity/rebinding, checksums, archive traversal protection, secret-path/text blocking, and opt-in selected untracked WIP files.
- Add plugin skills: `retry`, `handoff`, `continue-handoff`, `handoff-status`, and `retry-status`.
- Add `agy-retryctl` launcher and deterministic handoff/retry command surface.
- Add new-conversation rollover from a ready handoff without keyboard/PTY simulation.
- Upgrade HUD policy states; 5h + weekly quota share a row when width permits and reset text uses visible spacing (`↻ 1h55m`).
- Extend doctor/package verification and Node 24.21.0 CI matrix for Ubuntu/macOS/Windows.
- Full offline suite and extracted-artifact verification are release gates; live AGY/platform evidence remains explicitly separate.

## 0.3.3 - 2026-09-30

- Fix HUD metric-column drift: `ctx`, `5h`, and `week` now share a fixed visual grid for label, progress bar, percentage, and detail/reset columns.
- Add ANSI/wide-Unicode aware `padVisible()` so alignment uses terminal display width rather than JavaScript string length.
- Percentage values are right-aligned, keeping the `%` column stable for 1/2/3-digit values.
- Add regression coverage that asserts bar, percent-sign, and detail columns line up at the same terminal positions.

## 0.3.2 - 2026-09-30

- Fix native status-line startup on AGY 1.2.14 when the first status-line payload arrives before `conversation_id` / `session_id` exists.
- Startup payloads are now rendered ephemerally and exit 0; telemetry/retry persistence begins only after AGY provides a valid conversation id.
- Add regression coverage for pre-conversation status-line invocation.

## 0.2.2 - 2026-09-30

- Clarify release roles: the plugin-only archive is the recommended artifact for normal `agy plugin install`; the full project archive is for development/debugging.
- Add a top-level `PLUGIN-INSTALL.md` with exact commands for both archive types and the common “could not detect plugin structure” recovery.
- Add `scripts/verify-plugin-package.js` and regression tests to assert `plugin.json` is at the extracted plugin root and to reject accidentally installing the full project root.
- Correct the recommended CLI plugin status-line path to `~/.gemini/antigravity-cli/plugins/agy-retry-hud/...`, while documenting that some builds may stage shared plugins under `~/.gemini/config/plugins/`.

## 0.2.1 - 2026-09-30

- Closed the native packaging debt found during Revision 3 execution: the shipped plugin-level `hooks.json` no longer depends on an installer-only placeholder and can resolve its installed runtime from the standard Antigravity plugin locations.
- Added a regression test that executes the release `Stop` hook command directly from the staged plugin bundle.
- Added `scripts/live-verify.js` / `npm run verify:live` for safe read-only live probes (`--version`, `--help`, `plugin list`, `/hooks`, `/usage`) without starting a model turn.
- Kept the project installer as the recommended cross-platform auto-wiring path; direct `agy plugin install` is now supported for the plugin bundle, with status-line wiring still required just like reference HUD plugins.
- Offline suite expanded beyond the 0.2.0 baseline; authenticated AGY and target-OS live gates remain required before stable.

## 0.2.0 - 2026-09-30

- Changed the default UX from a separate wrapper HUD to a **native Antigravity CLI status-line HUD** rendered inside the normal `agy` TUI.
- Added a native plugin bundle (`plugin/agy-retry-hud`) with `plugin.json`, plugin-level `Stop` hook and bundled runtime.
- Added a cross-platform native installer/doctor/uninstaller that preserves unrelated AGY settings and restores a previous custom status line on uninstall.
- Added status-line telemetry parsing for conversation, workspace, model, context, 5h/weekly quota and agent state.
- Added conservative Stop-hook scheduling: the hook returns immediately; long waits happen in a detached worker, never inside the hook timeout.
- Added exact-conversation background resume using AGY stream mode and the existing continuation message.
- Added duplicate/race protection: repeated Stop events are deduplicated, a normal native Stop cancels a pending retry, and detected native TUI activity cancels background dispatch.
- Auth/billing/unknown errors and non-idle background work remain non-retryable without user action.
- Kept the 0.1.x wrapper as a fallback/diagnostic interface; it is no longer the intended primary UI.
- Live authenticated AGY, macOS and Windows smoke gates remain pending; 0.2.0 is still a pre-release.

## 0.1.1 - 2026-09-30

- Added an explicit AGY compatibility gate: minimum 1.1.15, recommended 1.2.13+.
- `doctor` reports AGY support and rejects older/unknown versions conservatively.
- Added version parser and CLI regression tests.
- Updated compatibility/review/execution evidence and CI to Node 24.21.0 LTS.

## 0.1.0 - 2026-09-30

- Initial pre-release wrapper with HUD, quota-aware retry scheduling, same-conversation resume, local state/locks, and offline synthetic integration tests.

## 0.3.1 - 2026-09-30

- Reworked the native status-line HUD into an adaptive 2–4 line ANSI-colored layout inspired by AGY's status-line capabilities.
- Fixed right-edge text collision/overflow by clipping on terminal display width rather than raw JavaScript string length; ANSI sequences and wide Unicode are accounted for.
- Added context and quota progress bars, plan tier, workspace/Git identity, task/artifact counts and compact token usage on wide terminals.
- Active-provider quota filtering prevents duplicate 5h/weekly buckets from unrelated model providers; long reset durations render as days.
- Added real retry-wait progress percentage. Task-completion percentage is intentionally not fabricated because AGY does not expose one.
- Added user HUD config with `NO_COLOR` support.
- Added `setup.js install` one-command flow: validate/install the plugin and wire `statusLine` while preserving unrelated settings.
- Full regression suite increased to 59 tests.
