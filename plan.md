# AGY Retry HUD v0.4.0 — Implementation Plan

**Plan status:** Executed — code/offline implementation complete; external live gates tracked separately  
**Spec:** `spec.md`  
**Execution style:** sequential workstreams with test gates  
**Target:** v0.4.0

---

# Execution status — 2026-09-30

| WS | Status |
|---|---|
| WS0 | Code contract complete; Node 24 + authenticated AGY evidence external |
| WS1 | COMPLETE |
| WS2 | COMPLETE |
| WS3 | COMPLETE |
| WS4 | COMPLETE |
| WS5 | COMPLETE |
| WS6 | COMPLETE |
| WS7 | COMPLETE |
| WS8 | COMPLETE |
| WS9 | COMPLETE |
| WS10 | COMPLETE |
| WS11 | COMPLETE |
| WS12 | Offline/artifact gates complete at packaging; live AGY/macOS/Windows gates remain external |

See `docs/V0.4-EXECUTION.md` for evidence and non-fabricated live-gate status.

# 1. Goal

Implement the approved v0.4.0 specification without regressing the working v0.3.x native HUD/retry integration.

The implementation must add:

- retry global/session controls;
- weekly quota hard blocking;
- handoff engine;
- portable `.agyh`;
- context-aware automatic handoff/rollover;
- AGY plugin skills;
- deterministic `agy-retryctl`;
- HUD v2 policy/status integration;
- installer/doctor/release updates.

The project must continue to work as a native AGY plugin.

---

# 2. Execution rules

1. Work sequentially.
2. Preserve working v0.3.x behavior before extending it.
3. Add failing tests before behavior changes where practical.
4. Do not change retry defaults simply to make a failing test pass.
5. Do not mark live AGY/macOS/Windows gates complete without evidence.
6. Do not implement TUI keyboard simulation.
7. Do not introduce a second handoff implementation for manual mode.
8. Do not let skills become the persistent source of truth.
9. Every portable archive must be treated as untrusted input.
10. Re-run the complete suite after every workstream affecting shared state.

---

# 3. Proposed modules

Logical layout:

```text
src/
├── cli/
│   ├── main.js
│   └── retryctl.js
├── config/
├── retry/
│   ├── controller.js
│   ├── policy.js
│   ├── overrides.js
│   └── weekly-gate.js
├── handoff/
│   ├── engine.js
│   ├── state.js
│   ├── snapshot.js
│   ├── semantic.js
│   ├── package.js
│   ├── import.js
│   ├── validate.js
│   ├── workspace.js
│   ├── secrets.js
│   └── schema.js
├── session/
│   ├── rollover.js
│   └── continuity.js
├── hud/
│   ├── model.js
│   ├── render.js
│   └── width.js
├── worker/
└── native-entry.js

plugin/agy-retry-hud/
├── plugin.json
├── hooks.json
├── setup.js
├── skills/
│   ├── retry/SKILL.md
│   ├── handoff/SKILL.md
│   ├── continue-handoff/SKILL.md
│   ├── handoff-status/SKILL.md
│   └── retry-status/SKILL.md
├── shared/handoff-schema-v1.json
└── dist/
```

Existing project structure may differ. Preserve the current architecture where it is already clean; this is a logical decomposition, not a mandatory rewrite.

---

# 4. Workstream order

```text
WS0  Baseline & contracts
WS1  Config + state schema v0.4
WS2  Retry control plane
WS3  Weekly quota hard gate
WS4  Handoff local engine
WS5  Portable .agyh
WS6  Manual handoff skill
WS7  Continue-handoff skill
WS8  Auto context handoff
WS9  Session rollover
WS10 HUD v2
WS11 Installer + doctor + packaging
WS12 Full acceptance + live gates
```

---

# WS0 — Baseline, migration and compatibility contract

## Objective

Freeze the v0.3.x working behavior before changing shared state.

## Tasks

- [ ] Extract current v0.3.x source as baseline.
- [ ] Run the complete existing suite.
- [ ] Record current passing test count.
- [ ] Confirm Node 24 execution.
- [ ] Record AGY 1.2.14 as the known target environment.
- [ ] Document capability checks required:
  - plugin;
  - hooks;
  - status line;
  - skills;
  - headless conversation support.
- [ ] Snapshot current config/state schemas.
- [ ] Define state migration path to v0.4.
- [ ] Ensure old v0.3 config remains loadable.

## Gate

No v0.4 implementation starts until:

```text
existing regression suite = PASS
```

---

# WS1 — v0.4 configuration and persistent state

## Objective

Create stable configuration/state foundations for retry overrides and handoff.

## Configuration tasks

- [ ] Add global retry config.
- [ ] Add weekly quota threshold.
- [ ] Add global handoff config.
- [ ] Add handoff thresholds.
- [ ] Add portable handoff options.
- [ ] Add schema validation.

## Conversation override model

Implement:

```text
retry override:
  inherit | on | off

handoff override:
  inherit | on | off
```

Key overrides by conversation ID.

## Persistent state additions

- [ ] retry effective/global/override state;
- [ ] handoff effective/global/override state;
- [ ] current handoff ID;
- [ ] current handoff lifecycle state;
- [ ] context threshold state;
- [ ] rollover armed state;
- [ ] rollover target/new conversation ID.

## Migration tests

- [ ] v0.3 config -> v0.4 default behavior.
- [ ] malformed override rejected.
- [ ] conversation A override never affects conversation B.
- [ ] atomic write survives interrupted update.

## Gate

```text
state/config tests PASS
existing regression PASS
```

---

# WS2 — Retry control plane

## Objective

Implement deterministic retry controls.

## CLI

Implement:

```bash
agy-retryctl retry on
agy-retryctl retry off

agy-retryctl retry session on
agy-retryctl retry session off
agy-retryctl retry session inherit

agy-retryctl retry status
```

## Policy

Effective retry state:

```text
conversation on  -> ON
conversation off -> OFF
inherit          -> global
```

## Tests

- [ ] global ON;
- [ ] global OFF;
- [ ] session ON overrides global OFF;
- [ ] session OFF overrides global ON;
- [ ] inherit restores global;
- [ ] restart preserves global config;
- [ ] restart preserves intended conversation override policy;
- [ ] unknown/no conversation returns useful error;
- [ ] disabling retry cancels future dispatch without corrupting current AGY turn.

## Gate

No background worker may dispatch if effective retry is OFF.

---

# WS3 — Weekly quota hard gate

## Objective

Make weekly exhaustion a first-class non-retryable state.

## Tasks

- [ ] Add `WEEKLY_BLOCKED`.
- [ ] Implement threshold default 1%.
- [ ] Require fresh, scope-correct weekly snapshot.
- [ ] Add single read-only refresh before dispatch when stale.
- [ ] Unknown after refresh -> `NEEDS_USER`.
- [ ] Prevent model dispatch when blocked.
- [ ] Prevent 5h timer loop while blocked.
- [ ] Preserve reset timestamp for HUD.

## Tests

- [ ] 5h exhausted + weekly healthy -> wait/retry.
- [ ] 5h healthy + weekly 0% -> block.
- [ ] 5h exhausted + weekly 0% -> block.
- [ ] weekly 0.5% with 1% threshold -> block.
- [ ] weekly stale -> refresh.
- [ ] weekly unknown after refresh -> needs user.
- [ ] weekly blocked -> zero model sends.
- [ ] mechanical handoff remains permitted.

## Gate

A test must prove:

```text
weekly exhausted => automatic model send count == 0
```

---

# WS4 — Local HandoffEngine

## Objective

Implement one handoff engine used by both automatic and manual workflows.

## Core interface

Suggested logical interface:

```text
create(trigger, mode, workspace, conversationState)
list()
show(id)
validate(id)
markConsumed(id, conversationId)
```

## Local structure

Create:

```text
.agy-retry/handoffs/<handoff-id>/
```

with:

- [ ] `HANDOFF.md`;
- [ ] `CONTINUE.md`;
- [ ] `manifest.json`;
- [ ] `state.json`;
- [ ] `workspace.json`;
- [ ] `git/status.txt`;
- [ ] evidence metadata.

## Mechanical snapshot

Collect without model turn:

- [ ] workspace/repo identity;
- [ ] branch;
- [ ] commits;
- [ ] dirty status;
- [ ] changed file paths;
- [ ] deterministic retry/handoff state;
- [ ] known checkpoint;
- [ ] test evidence already tracked by project state.

## `.git/info/exclude`

- [ ] Add `.agy-retry/` where appropriate.
- [ ] Do not automatically modify project `.gitignore`.

## Tests

- [ ] local handoff created;
- [ ] ID unique;
- [ ] paths relative;
- [ ] absolute path not required;
- [ ] source conversation recorded as provenance only;
- [ ] no model invocation in mechanical mode;
- [ ] corrupted local state rejected.

---

# WS5 — Portable `.agyh` v1

## Objective

Export/import a secure portable handoff.

## Schema

Implement:

```json
{
  "format": "agy-retry-handoff",
  "version": 1
}
```

## Export

Implement:

```bash
agy-retryctl handoff export <id>
agy-retryctl handoff create --portable
```

## Import

Implement:

```bash
agy-retryctl handoff import <file.agyh>
agy-retryctl handoff validate <file.agyh>
```

## Security

- [ ] zip-slip/path traversal protection;
- [ ] checksums;
- [ ] schema validation;
- [ ] secret scanner;
- [ ] default sensitive-file denylist;
- [ ] unsupported version rejection;
- [ ] archive size/file-count safety limits.

## Git WIP mode

- [ ] unstaged diff;
- [ ] staged diff;
- [ ] optional allowlisted untracked files;
- [ ] never automatically include `.env`, private keys or credentials.

## Portability tests

Test at least:

```text
Linux-style source path
→ export
→ Windows-style target path
→ workspace rebind
```

and reverse logical mapping.

## Gate

A `.agyh` continuation must not require:

```text
source absolute path
source conversation ID
```

---

# WS6 — Manual handoff skill

## Objective

Expose manual handoff creation inside AGY.

## Plugin skill

Create:

```text
skills/handoff/SKILL.md
```

Expected command:

```text
/agy-retry-hud:handoff
```

## Skill behavior

Without arguments:

1. inspect current conversation/workspace;
2. invoke deterministic handoff engine;
3. request semantic summary when allowed;
4. validate generated handoff;
5. show result and next actions.

Optional:

```text
/agy-retry-hud:handoff portable
```

## Skill prompt

Implement the approved semantic handoff contract from `spec.md`.

## Output choices

After creation:

```text
1. Stay in current session
2. Start new session from handoff
3. Export portable .agyh
```

## Tests

- [ ] plugin package discovers skill;
- [ ] no duplicated plugin namespace;
- [ ] manual handoff uses HandoffEngine;
- [ ] manual portable mode uses same validation/security;
- [ ] semantic failure falls back to mechanical when permitted.

---

# WS7 — Continue-handoff skill

## Objective

Continue local or imported handoffs safely.

## Plugin skill

Create:

```text
skills/continue-handoff/SKILL.md
```

Expected command:

```text
/agy-retry-hud:continue-handoff
```

## No-argument flow

Skill runs deterministic:

```bash
agy-retryctl handoff list --json
```

and renders a numbered list.

## Direct file flow

Support:

```text
/agy-retry-hud:continue-handoff ./task.agyh
```

## Reconciliation sequence

Must perform:

```text
handoff validation
workspace identity check
Git/worktree reconciliation
recorded-state verification
uncertain-side-effect review
first unfinished step
```

## Tests

- [ ] local handoff;
- [ ] imported handoff;
- [ ] numbered list;
- [ ] direct file;
- [ ] matching repo at different path;
- [ ] mismatching repo blocks;
- [ ] missing required file blocks;
- [ ] recorded completed state verified before continuing.

---

# WS8 — Automatic context handoff

## Objective

Add threshold-driven handoff preparation.

## Threshold state machine

Implement:

```text
<80       NORMAL
>=80      WARNING
>=85      SNAPSHOT_READY
>=90      PREPARE_SEMANTIC
>=95      ROLLOVER_ARMED
```

If native AGY compaction reduces context below 80:

```text
ROLLOVER_ARMED -> CANCELED
```

Prepared checkpoint may remain.

## Safe point

Before semantic handoff or rollover verify:

```text
agent idle
task_count == 0
pending input == 0
no tool confirmation
no unresolved side effect
no dispatch in progress
```

Unsafe:

```text
handoff:PENDING
```

## Tests

- [ ] 84% no snapshot;
- [ ] 85% one mechanical snapshot;
- [ ] repeated redraw does not create duplicate snapshot;
- [ ] 90% semantic prepare;
- [ ] 95% arm rollover;
- [ ] unsafe tool state defers;
- [ ] safe state resumes;
- [ ] native compaction to 70% cancels rollover;
- [ ] handoff creation does not trigger recursive status-line behavior.

---

# WS9 — Session rollover

## Objective

Create a fresh AGY conversation when context rollover is eligible.

## Preconditions

- [ ] effective handoff ON;
- [ ] rollover armed;
- [ ] handoff READY;
- [ ] safe point;
- [ ] weekly quota not blocked;
- [ ] no competing active AGY turn;
- [ ] valid workspace identity.

## Behavior

Create a new AGY headless conversation without binding to the old conversation ID.

Send the continue-handoff contract.

Capture the new conversation ID.

Persist:

```text
oldConversationId
newConversationId
handoffId
rolloverReason
timestamp
```

## Retry interaction

At retry deadline:

```text
if handoff READY
and context policy says rollover
then new conversation
else resume old conversation
```

## Tests

- [ ] high-context retry prefers new conversation.
- [ ] lower-context retry resumes old conversation.
- [ ] weekly block prevents new model turn.
- [ ] workspace mismatch prevents rollover.
- [ ] pending tool prevents rollover.
- [ ] new conversation ID stored.
- [ ] original conversation ID not required after portable handoff import.
- [ ] no keyboard/TUI simulation.

---

# WS10 — HUD v2

## Objective

Integrate all policy states and finalize visual style.

## Layout

Wide:

```text
╭─ ● WORKING │ Gemini 3.7 Flash (Medium) │ Pro │ git:main*
├─ ctx   █████████░ 91% used 910k/1M     │ handoff:READY
╰─ quota 5h ███░░░░ 19% ↻ 1h55m │ week ████░░░ 44% ↻ 1d20h │ retry:SESSION
```

## Requirements

- [ ] 5h + weekly on same row where possible.
- [ ] visible space after refresh icon.
- [ ] display-width-aware padding.
- [ ] ANSI does not shift columns.
- [ ] Unicode does not shift columns.
- [ ] narrow fallback.
- [ ] retry states.
- [ ] handoff states.
- [ ] weekly block visible.
- [ ] startup without conversation ID remains safe.
- [ ] no HUD redraw causes quota refresh/model call.

## Tests

Use snapshot/string-position assertions plus display-width assertions.

---

# WS11 — Remaining plugin skills, installer and doctor

## Skills

Add:

```text
skills/retry/SKILL.md
skills/handoff-status/SKILL.md
skills/retry-status/SKILL.md
```

## Retry skill

Map user intent to:

```text
agy-retryctl retry ...
```

## Installer

- [ ] plugin-only root recognized;
- [ ] full-source nested plugin recognized;
- [ ] status line wired automatically;
- [ ] existing unrelated status line protected;
- [ ] `--force-statusline`;
- [ ] uninstall restores previous configuration;
- [ ] skills included in installed plugin.

## Doctor

Validate:

- [ ] Node 24;
- [ ] AGY executable;
- [ ] capability detection;
- [ ] plugin install;
- [ ] status line;
- [ ] hooks;
- [ ] skills;
- [ ] handoff schema;
- [ ] state/config directories;
- [ ] read-only quota check when supported.

Doctor must not create a model turn.

---

# WS12 — Full acceptance and release

## Full automated run

- [ ] complete test suite;
- [ ] syntax/type/lint checks;
- [ ] extracted full-source artifact test;
- [ ] extracted plugin-only artifact test;
- [ ] checksum validation.

## CI matrix

Required:

```text
Ubuntu + Node 24
macOS + Node 24
Windows + Node 24
```

## Live AGY smoke

Where a logged-in environment exists:

- [ ] plugin install;
- [ ] `/skills` shows v0.4 skills;
- [ ] native HUD;
- [ ] manual retry controls;
- [ ] manual handoff;
- [ ] handoff list;
- [ ] continue handoff;
- [ ] startup no conversation;
- [ ] 5h quota display;
- [ ] weekly quota display.

Natural quota exhaustion must not be fabricated. If unavailable, mark the corresponding live quota gate unverified.

## Cross-device handoff acceptance

Perform at least one real or faithfully isolated test:

```text
workspace path A
→ create .agyh
→ new clean workspace path B
→ import
→ validate
→ continue
```

The second environment must not have access to the original conversation history.

---

# 5. Test matrix summary

| Area | Unit | Integration | Artifact | Live |
|---|---:|---:|---:|---:|
| Config/state | ✓ | ✓ | ✓ | |
| Retry control | ✓ | ✓ | ✓ | ✓ |
| Weekly hard gate | ✓ | ✓ | ✓ | conditional |
| Handoff local | ✓ | ✓ | ✓ | ✓ |
| `.agyh` | ✓ | ✓ | ✓ | ✓ |
| Secret protection | ✓ | ✓ | ✓ | |
| Skills | ✓ | ✓ | ✓ | ✓ |
| Context thresholds | ✓ | ✓ | ✓ | ✓ |
| Rollover | ✓ | ✓ | ✓ | ✓ |
| HUD | ✓ | ✓ | ✓ | ✓ |
| Installer/doctor | ✓ | ✓ | ✓ | ✓ |

---

# 6. Definition of done

v0.4.0 implementation is complete when all code-level acceptance criteria from `spec.md` pass.

A platform may only be labeled **verified** when live evidence exists on that platform.

A feature may not be labeled **live quota verified** solely because a synthetic fixture passed.

---

# 7. Release artifacts

Produce:

```text
agy-retry-hud-plugin-v0.4.0.zip
agy-retry-hud-v0.4.0.zip
spec.md
plan.md
SHA256SUMS
```

Optional:

```text
agy-retry-hud-plugin-v0.4.0.tar.gz
```

The plugin-only archive is the recommended installation artifact.

---

# 8. Migration notes

Upgrade must preserve:

- existing status-line configuration backup/restore;
- current retry defaults unless superseded by approved v0.4 defaults;
- existing user config;
- existing retry state where safely migratable.

New features default to the values in `spec.md`.

If legacy state cannot be migrated safely:

```text
do not guess
→ archive old state
→ initialize v0.4 state
→ report migration warning
```

---

# 9. Recommended commit/workstream boundaries

Suggested commit boundaries:

```text
WS0  chore: baseline v0.4 contracts
WS1  feat: add v0.4 config and state
WS2  feat: add retry control plane
WS3  feat: add weekly quota hard gate
WS4  feat: add local handoff engine
WS5  feat: add portable agyh format
WS6  feat: add manual handoff skill
WS7  feat: add continue handoff skill
WS8  feat: add context handoff policy
WS9  feat: add session rollover
WS10 feat: finalize HUD v2
WS11 feat: add controls skills and installer integration
WS12 release: validate and package v0.4.0
```

Do not combine large shared-state refactors across multiple workstreams unless required to keep the repository buildable.

---

# 10. Execution handoff

An implementation agent should:

1. read `spec.md` fully;
2. read this `plan.md`;
3. inspect the current v0.3.x code before modifying it;
4. run the existing full suite;
5. start WS0;
6. execute workstreams sequentially;
7. report completion by workstream with:
   - files changed;
   - tests added;
   - tests run;
   - pass/fail result;
   - unresolved gates;
8. never mark a live-platform gate complete without observed evidence.

This plan is ready for execution.


# WS13 — Stale Retry Protection / Incident Lifecycle (v0.4.5 hardening)

- [x] Add conversation-local retry incident records.
- [x] Bind detached workers to the exact incident id.
- [x] Resolve incident on newer normal Stop/SUCCESS.
- [x] Add plugin `PreInvocation` hook and supersede pending incident on a newer invocation.
- [x] Re-check incident after wait/quota gates and immediately before model send.
- [x] Prevent stale worker from dispatching a newer incident.
- [x] Add multi-session isolation regression: completed session A receives zero sends when session B exhausts quota.
- [x] Add Windows quote-safe `PreInvocation` hook command coverage.
- [x] Package both Stop + PreInvocation hooks in direct-install plugin artifact.
- [ ] Live AGY 1.2.14 verification of manual continuation superseding a waiting retry remains a live-evidence gate.


## v0.4.7 hardening execution update

- [x] Manual PreInvocation supersedes NEEDS_USER and PAUSED_UNCERTAIN state from an older retry incident.
- [x] Add `retry clear` without disabling retry policy.
- [x] Add terminal-instance conversation binding before cwd/latest fallback.
- [x] Report conversation-resolution source from retry status.
- [x] Detect multiple live CLI instances for the same conversation.
- [x] Block auto retry at Stop-time and again at worker dispatch-time for multi-CLI conflicts.
- [x] Render `retry:MULTI-CLI`.
- [x] Add focused regression tests and run full suite.


## v0.4.8 hardening execution update

- [x] Reproduce exact `Individual quota reached ... Resets in 2h23m10s` wording.
- [x] Confirm policy parser extracts compact `h/m/s` reset duration.
- [x] Permit confirmed retryable quota/transient incidents when Stop has `fullyIdle=false`.
- [x] Keep non-idle normal Stop deferred.
- [x] Add structured exhausted-5h fallback when Stop error text is omitted.
- [x] Add sanitized `lastStop` diagnostics.
- [x] Add negative control so healthy 5h telemetry cannot fabricate a quota incident.
- [x] Run full regression: 108/108 PASS.


## v0.4.9 execution update

- [x] Replace retry progress percentage with wall-clock countdown in native HUD.
- [x] Show sanitized retry reason (`503`, `QUOTA`, etc.) and attempt/max budget.
- [x] Persist detached-worker PID/heartbeat/deadline-source scheduler metadata.
- [x] Heartbeat long waits without polling model/quota endpoints.
- [x] Expose `OK/STALE/LOST/CHECK/DISPATCH/RUNNING` health/state.
- [x] Add `agy-retryctl retry scheduler [--json]`.
- [x] Embed scheduler diagnostics in `retry status --json`.
- [x] Preserve weekly/multi-CLI/manual-supersede safety gates.
- [x] Full regression: 113/113 PASS.


# v0.5.0 execution completion

- [x] Phase 1: singleton embedded daemon, PID/heartbeat, crash-safe status, no systemd.
- [x] Phase 2: daemon-owned retry scheduler, durable wait rehydration, shared dispatch semaphore.
- [x] Phase 3: HUD hide/off controls; existing countdown/type/attempt/scheduler health preserved.
- [x] Phase 4: `agy-retryctl daemon`, `hud`, and `doctor` commands.
- [x] Phase 5: `hud-control`, `daemon-control`, `doctor` skills.
- [x] Phase 6: v0.4 config/state migration and daemon adoption; existing portable auto-handoff retained.
- [x] Phase 7: regression + plugin package verification + extracted-artifact retest.
