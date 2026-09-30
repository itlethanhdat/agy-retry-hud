# v0.4.0 Execution Report

Date: 2026-09-30

This report maps the approved `plan.md` to implementation evidence. It deliberately separates **code/offline verification** from **live external release evidence**.

## Summary

| Workstream | Code/offline status | Notes |
|---|---|---|
| WS0 Baseline & contracts | COMPLETE with external runtime gate | v0.3.x baseline retained; Node 24/AGY live runtime cannot be executed in the current sandbox. |
| WS1 Config + state | COMPLETE | Nested v0.4 config, migration from flat HUD config, global/session overrides. |
| WS2 Retry control plane | COMPLETE | `agy-retryctl retry ...` + skill mapping. |
| WS3 Weekly hard gate | COMPLETE | <=1% default hard block, stale/unknown conservative behavior. |
| WS4 Local HandoffEngine | COMPLETE | Mechanical checkpoints, Git/workspace identity, shared engine. |
| WS5 Portable `.agyh` | COMPLETE | ZIP v1, checksums, path safety, secret blocking, selected WIP inclusion. |
| WS6 Manual handoff skill | COMPLETE | `/agy-retry-hud:handoff`, semantic + mechanical fallback flow. |
| WS7 Continue-handoff skill | COMPLETE | local/imported/list/direct-file reconciliation flow. |
| WS8 Auto context handoff | COMPLETE | 80/85/90/95 thresholds, safe-point defer, native-compaction cancel. |
| WS9 Session rollover | COMPLETE | New headless conversation with continuation contract; no keyboard simulation. |
| WS10 HUD v2 | COMPLETE | same-row quota, reset spacing, retry/handoff states, adaptive width. |
| WS11 Skills/setup/doctor | COMPLETE | five skills, launcher, installer, schema/package checks. |
| WS12 Acceptance/release | OFFLINE COMPLETE; LIVE GATES PENDING | Full suite/artifact checks performed locally; target-host/live AGY evidence remains external. |

## Implemented acceptance behavior

- Global retry ON/OFF.
- Per-conversation retry `on|off|inherit`.
- Retry-only-this-session composition.
- Weekly quota hard block with zero automatic model dispatch.
- Global/per-conversation auto-handoff control.
- Mechanical snapshot at 85%.
- Semantic handoff at 90% when safe/quota healthy.
- Rollover arm at 95%.
- Native compaction below 80% cancels armed rollover.
- Portable handoff independent of source absolute path and conversation ID.
- Git workspace rebind on a different path.
- Secret filtering, checksum validation, archive path traversal protection.
- Explicit selected safe untracked WIP inclusion.
- New-conversation rollover without reusing old conversation ID.
- Native plugin skills and deterministic `agy-retryctl` control plane.
- HUD v2 with same-row 5h/weekly metrics when width permits.

## Automated evidence

Final source test suite is recorded during release packaging. Required commands:

```bash
npm test
npm run verify:plugin-package
node src/cli.js demo --plain --data-dir .demo-state
node src/retryctl.js --help
```

Syntax gate:

```bash
node --check src/*.js
node --check scripts/*.js
```

Artifact gate:

1. Build plugin `dist/`.
2. Create plugin-only archive.
3. Create full-source archive.
4. Extract both into clean directories.
5. Verify plugin package from extracted plugin archive.
6. Run the full test suite from extracted full-source archive.
7. Verify checksums.

## External release gates not fabricated

The current execution environment has:

```text
Linux sandbox
Node v22.16.0
No `agy` executable / authenticated AGY account
```

The target contract is Node 24.x, and the known user environment is AGY 1.2.14. Therefore the following remain external evidence gates rather than being marked PASS from synthetic tests:

- real Node 24 execution in this sandbox;
- authenticated AGY plugin load;
- `/skills` visibility in a real AGY process;
- live Stop-hook payloads;
- live status-line visual smoke;
- natural quota exhaustion/recovery;
- real macOS live smoke;
- real Windows live smoke.

CI is configured for Node 24.21.0 on Ubuntu/macOS/Windows, but configuration alone is not reported as a completed hosted CI run.

## Release policy

v0.4.0 may be described as **implementation complete / offline verified** after all packaging gates pass.

It must not be described as fully live-verified on every target OS until the external gates above are observed.

## Final packaging evidence

Final pre-release packaging validation performed on 2026-09-30:

```text
Source suite:                 80/80 PASS
Extracted full-source ZIP:   80/80 PASS
Extracted plugin verifier:   PASS (5 skills, handoff schema v1)
JavaScript syntax checks:    PASS
Fallback demo:               PASS
retryctl help/control smoke: PASS
Packaged status-line smoke:  PASS
Portable .agyh create/validate with explicitly selected untracked WIP: PASS
```

Packaged HUD smoke:

```text
╭─ ● READY    │ Gemini 3.7 Flash (Medium) │ Google AI Pro │ tmp
├─ ctx   █████████░  91% used 954k/1M     │ retry:ON
╰─ quota 5h ██░░░░░░ 19% ↻ 1h55m │ week ████░░░░ 44% ↻ 1d20h
```

The artifact smoke also caught and fixed a pre-release label-width regression (`quot` -> `quota`) before final packaging.
