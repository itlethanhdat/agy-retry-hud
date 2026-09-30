# AGY Retry HUD v0.4.0 — Product & Technical Specification

**Status:** Approved specification  
**Target release:** v0.4.0  
**Product:** `agy-retry-hud`  
**Primary UX:** Native Antigravity CLI (`agy`) TUI integration  
**Secondary control surface:** `agy-retryctl` local CLI  
**Handoff format:** portable `.agyh` bundle  
**Target platforms:** Linux, macOS, Windows

---

## 1. Purpose

`agy-retry-hud` extends Antigravity CLI with four tightly integrated capabilities:

1. **Native HUD inside `agy`**
   - Show model, plan, workspace/repository, context usage, 5-hour quota, weekly quota, retry state, handoff state, and relevant progress indicators.
   - Render adaptively without corrupting or overflowing the native terminal UI.

2. **Safe automatic retry**
   - Retry transient API failures and eligible 5-hour quota exhaustion.
   - Support global enable/disable and per-conversation overrides.
   - Never auto-retry when weekly quota is exhausted or below the configured safety threshold.

3. **Portable handoff and session rollover**
   - Prepare and export a self-contained handoff that can be continued in a new AGY conversation.
   - Handoff must work on another device, OS, path, and conversation without depending on the original conversation ID or absolute paths.

4. **Native AGY skills**
   - Expose retry and handoff workflows through plugin skills discoverable from `/skills`.
   - Provide manual handoff creation and continuation from existing handoffs.

The project must prioritize **continuity, non-duplication of side effects, portability, and conservative automation** over aggressive retry behavior.

---

# 2. Product principles

## 2.1 Preserve the native AGY experience

The user continues to launch:

```bash
agy
```

The plugin must not replace the AGY TUI with a custom full-screen wrapper.

The native status line is the primary HUD surface. The headless AGY interface may be used in the background for controlled continuation, retry, or new-session creation.

## 2.2 Never guess through uncertainty

If the plugin cannot prove that an automatic continuation is safe, it must stop in a visible state such as:

```text
NEEDS_USER
PAUSED_UNCERTAIN
WEEKLY_BLOCKED
WORKSPACE_MISMATCH
```

It must not invent a successful state or silently rerun potentially destructive operations.

## 2.3 Control logic must be deterministic

The AI skill layer is a user-facing orchestration layer.

The deterministic source of truth is:

```text
agy-retryctl
```

Skills must call or instruct the deterministic control layer rather than own persistent state themselves.

## 2.4 Manual and automatic handoff share one engine

There must be exactly one `HandoffEngine`.

It may be triggered by:

- automatic context thresholds;
- context exhaustion;
- retry rollover;
- explicit user skill;
- explicit CLI command.

Manual and automatic handoffs must use the same schema, validation, packaging, security rules, and continuation contract.

---

# 3. Supported architecture

```text
┌─────────────────────────────────────────────┐
│                 AGY native TUI              │
│                                             │
│   statusline JSON ───────────────┐           │
│   plugin skills                  │           │
│   Stop hook                      │           │
└─────────────────────────────────┼───────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │     agy-retry-hud core    │
                    │                           │
                    │ HUD renderer              │
                    │ Retry policy              │
                    │ Handoff engine            │
                    │ Session policy            │
                    │ Local state               │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │       agy-retryctl         │
                    │                           │
                    │ config / controls         │
                    │ handoff create/list/import│
                    │ retry overrides           │
                    │ diagnostics               │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │ Background retry worker   │
                    │ / headless AGY adapter    │
                    └───────────────────────────┘
```

---

# 4. Compatibility policy

The product targets the AGY generation that provides:

- plugin loading;
- plugin-provided skills;
- native status-line command integration;
- hooks;
- headless stream/JSON conversation support;
- explicit conversation IDs;
- quota/context information needed by the HUD.

The known target environment for v0.4.0 is **AGY 1.2.14**.

Compatibility must be based on **capability detection**, not only a version string.

`doctor` must fail or downgrade gracefully when a required capability is missing.

No feature may silently assume that an undocumented TUI API exists.

---

# 5. Plugin package structure

The plugin package must follow this logical structure:

```text
agy-retry-hud/
├── plugin.json
├── hooks.json
├── setup.js
├── config.example.json
├── skills/
│   ├── retry/
│   │   └── SKILL.md
│   ├── handoff/
│   │   └── SKILL.md
│   ├── continue-handoff/
│   │   └── SKILL.md
│   ├── handoff-status/
│   │   └── SKILL.md
│   └── retry-status/
│       └── SKILL.md
├── hooks/
│   ├── status-line.sh
│   ├── status-line.ps1
│   └── ...
├── shared/
│   └── handoff-schema-v1.json
└── dist/
    └── ...
```

The plugin must be installable from the extracted plugin root.

The full development project may contain the plugin under a nested folder, but release documentation must clearly distinguish:

- **plugin-only artifact** — recommended for installation;
- **full source artifact** — for development/debugging.

---

# 6. Native HUD

## 6.1 Required HUD information

The HUD should show as available:

- agent state;
- model;
- account/plan label;
- workspace or repository name;
- Git branch and dirty state;
- context percentage;
- context token usage where supported;
- 5-hour quota remaining;
- weekly quota remaining;
- reset durations;
- retry policy state;
- handoff state;
- retry countdown/progress when waiting.

Missing data must display as `unknown` or be omitted. Missing values must never be rendered as fake zeroes.

## 6.2 Wide layout

When terminal width permits:

```text
╭─ ● WORKING │ Gemini 3.7 Flash (Medium) │ Pro │ git:main*
├─ ctx   █████████░ 91% used 910k/1M     │ handoff:READY
╰─ quota 5h ███░░░░ 19% ↻ 1h55m │ week ████░░░ 44% ↻ 1d20h │ retry:SESSION
```

## 6.3 Narrow fallback

When the wide layout cannot fit:

```text
╭─ ● READY │ Gemini 3.7 Flash │ Pro
├─ ctx  █████████░ 91% │ handoff:READY
├─ 5h   ███░░░░░░ 19% ↻ 1h55m
╰─ week ████░░░░░ 44% ↻ 1d20h
```

## 6.4 Alignment requirements

Renderer must use terminal **display width**, not JavaScript string length.

Alignment must account for:

- ANSI color sequences;
- Unicode box drawing;
- wide Unicode characters;
- progress bars;
- variable-width percentage strings;
- narrow terminal clipping.

The following must align consistently:

- metric labels;
- progress bars;
- percentages;
- reset/detail column.

Reset icon and duration must include a visible separator:

```text
↻ 1h55m
↻ 1d20h
```

Never:

```text
↻1h55m
↻1d20h
```

## 6.5 Quota row

When width permits, 5-hour and weekly quota **must be on the same row**.

The renderer may split them only when required to avoid truncation.

## 6.6 HUD state labels

Retry examples:

```text
retry:ON
retry:OFF
retry:SESSION
retry:WAIT 1h55m
retry:WEEKLY BLOCK
retry:NEEDS USER
```

Handoff examples:

```text
handoff:OFF
handoff:PREP
handoff:PENDING
handoff:READY
handoff:ROLLOVER
handoff:BLOCKED
```

---

# 7. Retry controls

## 7.1 Configuration model

Retry uses two levels:

### Global policy

```text
enabled = true | false
```

### Conversation override

```text
inherit | on | off
```

Effective retry state:

```text
if conversationOverride == on  -> ON
if conversationOverride == off -> OFF
otherwise                       -> global value
```

“Retry only this session” is represented as:

```text
global retry = OFF
conversation override = ON
```

Conversation overrides are keyed by AGY conversation ID and must not leak into another conversation.

## 7.2 CLI controls

Required commands:

```bash
agy-retryctl retry on
agy-retryctl retry off

agy-retryctl retry session on
agy-retryctl retry session off
agy-retryctl retry session inherit

agy-retryctl retry status
```

## 7.3 Retry plugin skill

Skill exposed in AGY:

```text
/agy-retry-hud:retry
```

Supported intents:

```text
/agy-retry-hud:retry on
/agy-retry-hud:retry off

/agy-retry-hud:retry session on
/agy-retry-hud:retry session off
/agy-retry-hud:retry session inherit

/agy-retry-hud:retry status
```

Without arguments, the skill should show the available choices and current effective state.

The skill is an UX layer over `agy-retryctl`.

---

# 8. Retry policy

## 8.1 Eligible automatic retry

Eligible categories:

- transient transport failure;
- retryable model/API 502/503/504;
- explicitly retryable 429;
- eligible individual/5-hour quota exhaustion.

Native AGY retry must be allowed to finish before wrapper retry begins.

## 8.2 Non-retryable categories

Do not automatically retry:

- user cancellation;
- authentication failure;
- billing/credit failure;
- permission request requiring user action;
- unknown protocol state;
- ambiguous side effect;
- weekly quota exhausted;
- daily/long quota without a safe known policy;
- workspace mismatch;
- pending tool state whose outcome is uncertain.

---

# 9. Weekly quota hard gate

Weekly exhaustion is a **hard stop**, not another timer.

Default:

```json
{
  "retry": {
    "stopWhenWeeklyExhausted": true,
    "weeklyRemainingThreshold": 0.01
  }
}
```

When a fresh, scope-correct weekly quota snapshot has:

```text
remaining <= 1%
```

the state becomes:

```text
WEEKLY_BLOCKED
```

Behavior:

- do not schedule automatic model retry;
- do not wake every 5 hours;
- do not send continuation prompts;
- HUD must show the block and reset estimate if known.

If weekly quota is stale or unknown:

1. allow one read-only refresh before dispatch;
2. if still unknown, enter `NEEDS_USER`;
3. do not guess that quota is available.

A mechanical handoff may still be created without a model turn.

---

# 10. Retry timing

Default retry policy:

```text
quota fallback:         5h
reset margin:           90s
positive jitter:        0–30s
transient base:         60s
transient max:          15m
max transient retries:  6
max quota retries:      2
max job elapsed:        24h
```

Server-provided minimum delay must be respected.

The system must never poll quota by sending model prompts.

---

# 11. Handoff overview

A handoff is a portable continuation checkpoint.

It must allow this workflow:

```text
Device A
Conversation A
Workspace /home/user/project

        ↓ create/export

task.agyh

        ↓ copy

Device B
Conversation B
Workspace D:\Source\project

        ↓ validate/rebind

Continue safely
```

The handoff must not require:

- the original conversation ID;
- the original machine path;
- the original operating system;
- the original terminal process.

---

# 12. Handoff triggers

## 12.1 Automatic

Default context thresholds:

```text
80%  -> HUD warning
85%  -> mechanical snapshot
90%  -> semantic handoff preparation
95%  -> eligible for rollover
<80% -> cancel armed rollover after native compaction
```

Defaults:

```json
{
  "handoff": {
    "enabled": true,
    "snapshotAt": 85,
    "prepareAt": 90,
    "rolloverAt": 95,
    "cancelRolloverBelow": 80,
    "autoCreateNewSession": true,
    "semanticSummary": true,
    "mechanicalFallback": true
  }
}
```

## 12.2 Manual

Manual handoff can be requested at any context usage level:

```text
/agy-retry-hud:handoff
```

or:

```bash
agy-retryctl handoff create
```

Manual and automatic triggers must call the same `HandoffEngine`.

---

# 13. Safe point policy

Automatic semantic handoff or rollover must not occur while the conversation is unsafe.

Required safe conditions:

```text
agent_state == idle
task_count == 0
pending_input_count == 0
tool_confirmation_pending == false
no dispatch in progress
no unresolved tool side effect
```

If a threshold is reached while unsafe:

```text
handoff:PENDING
```

The handoff operation waits until a safe point.

A database migration, deployment, file mutation, or other side-effecting tool operation must never be duplicated solely because context rollover happened.

---

# 14. Relationship with native AGY compaction

`agy-retry-hud` must not pretend to replace AGY's internal context compaction.

The plugin performs **handoff compaction**, not internal context compaction.

If AGY naturally compacts context:

```text
92% -> 60%
```

the pending rollover must be canceled when it falls below:

```text
cancelRolloverBelow
```

The prepared handoff may remain as a checkpoint, but no new conversation is created automatically.

---

# 15. Handoff modes

## 15.1 Semantic handoff

Uses the agent when model quota permits.

Purpose:

- synthesize the work state;
- distinguish confirmed vs uncertain actions;
- capture decisions and next work;
- make the handoff understandable to a new session.

## 15.2 Mechanical handoff

Must work without a model call.

Captures deterministic information such as:

- Git remote;
- branch;
- commit;
- dirty state;
- changed files;
- local retry state;
- checkpoint metadata;
- known test evidence;
- referenced project docs;
- current workspace identity.

When model quota is unavailable, semantic handoff degrades to mechanical handoff.

Example:

```text
context = 94%
weekly quota = 0%

→ mechanical handoff
→ handoff:READY
→ WEEKLY_BLOCKED
→ no new model turn
```

---

# 16. Local handoff storage

Local handoffs use:

```text
.agy-retry/
└── handoffs/
    └── <handoff-id>/
        ├── HANDOFF.md
        ├── CONTINUE.md
        ├── manifest.json
        ├── state.json
        ├── workspace.json
        ├── git/
        │   ├── status.txt
        │   ├── diff.patch
        │   └── untracked.json
        └── evidence/
            └── tests.json
```

The project should add the local directory to:

```text
.git/info/exclude
```

when appropriate rather than automatically modifying project `.gitignore`.

---

# 17. Portable `.agyh` format

Portable handoff artifact:

```text
<task-name>-<timestamp>.agyh
```

`.agyh` is a versioned archive containing:

```text
handoff/
├── manifest.json
├── HANDOFF.md
├── CONTINUE.md
├── workspace.json
├── state.json
├── git/
│   ├── status.txt
│   ├── diff.patch
│   └── untracked.json
├── evidence/
│   └── tests.json
└── checksums.json
```

Required format metadata:

```json
{
  "format": "agy-retry-handoff",
  "version": 1
}
```

Future versions must support explicit migration.

---

# 18. Portability rules

## 18.1 No absolute-path dependency

Source machine paths may be retained only as informational metadata.

Continuation logic must not depend on them.

All repository file references in handoff content must be relative to workspace root.

## 18.2 Workspace identity

Git-backed workspace identity should include:

```json
{
  "type": "git",
  "remote": "<normalized remote>",
  "branch": "<branch>",
  "baseCommit": "<commit>",
  "headCommit": "<commit>"
}
```

Import/continue must validate the current workspace against this identity.

## 18.3 Conversation identity

`sourceConversationId` may be stored for provenance only.

It must not be required to continue a handoff.

A handoff must support:

```text
old machine + old conversation
→ .agyh
→ new machine + completely new conversation
```

---

# 19. Portable handoff modes

## 19.1 Reference mode

Default.

Contains:

- handoff documents;
- repo identity;
- branch/commit metadata;
- state;
- evidence.

Assumes code is already cloneable or synchronized.

## 19.2 Portable work-in-progress mode

Explicit mode:

```text
/agy-retry-hud:handoff portable
```

or:

```bash
agy-retryctl handoff create --portable
```

May additionally contain:

- unstaged diff;
- staged diff;
- explicitly allowed untracked files.

It must not blindly package all untracked files.

---

# 20. Handoff security

Default excluded content:

```text
.env
.env.*
*.pem
*.key
credentials*
secrets*
node_modules/
.git/
.venv/
venv/
dist/
build/
```

Secret detection should flag patterns such as:

```text
PRIVATE KEY
AWS_SECRET
PASSWORD=
TOKEN=
DATABASE_URL=
```

If a potentially sensitive file is detected:

```text
HANDOFF BLOCKED
```

The user must explicitly exclude it or explicitly approve a safe inclusion workflow.

No credential, access token, API key, login cookie, or account secret may be silently packed into `.agyh`.

---

# 21. `HANDOFF.md` contract

Recommended structure:

```markdown
---
handoff_version: 1
project: <project>
created_at: <timestamp>
reason: <manual|context_rollover|retry_rollover|context_exhausted>
quality: <semantic|mechanical>
---

# Goal

# User Requirements

# Decisions Already Approved

# Current Architecture / Approach

# Completed Work

# Work In Progress

# Last Confirmed Checkpoint

# Files Changed

# Tests / Verification

# Known Problems

# Uncertain Side Effects

# Do Not Repeat

# Next Step

# Relevant Documents

# Continuation Contract
```

The handoff must be **executable, not narrative**.

It should focus on:

- what is confirmed complete;
- what remains;
- what is uncertain;
- what must not be repeated;
- what to do next.

It must not reproduce the full conversation.

---

# 22. Semantic handoff prompt

The handoff skill should enforce a prompt equivalent to:

> Create a continuation handoff for another agent session that may run on a different machine and has no access to this conversation history. Capture the task goal, explicit user requirements, approved decisions, current implementation state, completed work, unfinished work, relevant workspace-relative files, test evidence, known failures, uncertain side effects, and the exact next action. Distinguish confirmed facts from assumptions. Do not copy the full conversation. Do not include credentials, tokens, secrets, machine-specific absolute paths, or irrelevant history. Do not claim an operation succeeded unless its result was verified. Identify operations that must not be repeated. References to repository files must be relative to the workspace root. The handoff must be sufficient for a new session to safely continue without relying on the original conversation ID.

Additional invariant:

```text
HANDOFF MUST BE EXECUTABLE, NOT NARRATIVE.
```

---

# 23. Continue-handoff prompt

Continuation skill should enforce a prompt equivalent to:

> Continue the task described by the supplied portable handoff. Treat the handoff as a checkpoint, not as unquestionable truth. First validate the current workspace against the handoff manifest, then inspect the current repository state, relevant files, Git status, and referenced plans/specifications. Confirm which recorded completed actions are still reflected in the workspace. Do not repeat completed operations or side effects. Resolve any items marked uncertain before continuing. Machine-specific paths from the source environment must not be reused; resolve all repository paths relative to the current workspace root. Preserve the approved requirements, decisions, constraints, and scope documented in the handoff. Continue from the first unfinished actionable step. If the workspace does not match, required files are missing, or the recorded state cannot be verified, stop and ask for clarification rather than guessing.

Continuation sequence:

```text
validate handoff
→ validate workspace
→ reconcile Git/worktree
→ reconcile recorded state
→ verify uncertain actions
→ continue first unfinished step
```

---

# 24. Handoff skills

## 24.1 Manual create

```text
/agy-retry-hud:handoff
```

Optional examples:

```text
/agy-retry-hud:handoff "Move work to another device"
/agy-retry-hud:handoff portable
```

Expected result:

```text
Handoff ready: h-af92

1. Stay in current session
2. Start a new session from this handoff
3. Export portable .agyh
```

## 24.2 Continue existing handoff

```text
/agy-retry-hud:continue-handoff
```

No argument:

- query `agy-retryctl handoff list --json`;
- present numbered choices;
- allow user selection.

Direct path:

```text
/agy-retry-hud:continue-handoff ./task.agyh
```

The v0.4.0 implementation must not fake a native AGY overlay API if none exists.

A numbered skill interaction is acceptable.

## 24.3 Status

```text
/agy-retry-hud:handoff-status
/agy-retry-hud:retry-status
```

These read local deterministic state and must not initiate model work unless required by the AGY skill runtime itself.

---

# 25. Handoff CLI

Required commands:

```bash
agy-retryctl handoff create
agy-retryctl handoff create --portable

agy-retryctl handoff list
agy-retryctl handoff list --json

agy-retryctl handoff show <id>
agy-retryctl handoff export <id>
agy-retryctl handoff import <file.agyh>

agy-retryctl handoff validate <id|file.agyh>
agy-retryctl handoff continue <id|file.agyh>

agy-retryctl handoff status
```

Future-safe command:

```bash
agy-retryctl handoff migrate <file.agyh>
```

---

# 26. Handoff lifecycle

States:

```text
PREPARING
READY
IMPORTED
CONSUMING
ACTIVE
COMPLETED
STALE
INVALID
WORKSPACE_MISMATCH
BLOCKED_SECRET
```

Consumption must not delete a handoff.

Store:

```text
consumedAt
consumedByConversationId
```

when known.

---

# 27. New-session rollover

When context is above rollover threshold and a safe handoff is ready:

```text
OLD CONVERSATION
        ↓
portable/local handoff
        ↓
new headless AGY conversation
        ↓
continue-handoff contract
        ↓
NEW conversation ID
```

The new conversation must preserve when supported:

- canonical workspace;
- model;
- agent/mode;
- non-sensitive profile scope.

Do not assume the currently open native TUI can be forced to switch to the new conversation.

Instead:

- store/display the new conversation ID;
- allow the user to reopen/resume it;
- allow the background worker to continue it when policy permits.

No keyboard simulation is allowed.

---

# 28. Interaction between retry and handoff

Example:

```text
context = 93%
→ handoff READY

5h quota exhausted
→ WAIT_QUOTA

quota becomes available
→ weekly quota checked

weekly exhausted
→ WEEKLY_BLOCKED
→ no dispatch

weekly available
+ context still above rollover policy
+ handoff READY
→ create new conversation
→ continue from handoff
```

When context is near exhaustion, retry must prefer a safe rollover over resuming an almost-full old conversation.

---

# 29. Interaction when weekly quota is exhausted

If weekly quota is exhausted:

```text
context high
→ mechanical handoff allowed
→ handoff READY
→ retry WEEKLY_BLOCKED
→ no automatic new model turn
→ no automatic new conversation dispatch
```

The handoff remains portable and available for another device/account/session as appropriate.

---

# 30. Configuration

Example user configuration:

```json
{
  "hud": {
    "color": true,
    "multiline": true,
    "showProgressBar": true,
    "showPlan": true,
    "showBranch": true,
    "showCwd": true,
    "showTokens": true,
    "showAgentState": true,
    "showRetry": true,
    "showHandoff": true,
    "barWidth": 10
  },
  "retry": {
    "enabled": true,
    "stopWhenWeeklyExhausted": true,
    "weeklyRemainingThreshold": 0.01,
    "quotaFallback": "5h",
    "resetMargin": "90s",
    "transientBase": "60s",
    "transientCap": "15m",
    "maxTransientRetries": 6,
    "maxQuotaRetries": 2
  },
  "handoff": {
    "enabled": true,
    "snapshotAt": 85,
    "prepareAt": 90,
    "rolloverAt": 95,
    "cancelRolloverBelow": 80,
    "autoCreateNewSession": true,
    "semanticSummary": true,
    "mechanicalFallback": true
  }
}
```

Configuration precedence:

```text
explicit CLI flags
> explicit config path
> user config
> defaults
```

Conversation overrides are stored separately from global defaults.

---

# 31. Persistent state

Persistent state may include:

```text
schemaVersion
jobId
conversationId
workspace identity
retry global/effective state
conversation retry override
handoff global/effective state
conversation handoff override
nextRetryAt
retry counters
error fingerprint
quota snapshot metadata
context health
handoff ID/state
last confirmed checkpoint
pending tool state
new rollover conversation ID
```

Persistent writes must be atomic.

Crash during an uncertain dispatch must produce:

```text
PAUSED_UNCERTAIN
```

not an automatic replay.

---

# 32. Background worker invariants

There must be at most one active retry/rollover worker per conversation/workspace lock.

Before dispatch it must verify:

- retry is effectively ON;
- not canceled;
- weekly quota not blocked;
- old child/process is no longer active;
- TUI/agent is not actively executing a conflicting turn;
- conversation/workspace identity is valid;
- no unsafe pending tool state;
- retry budget remains.

No recursive Stop-hook retry chain is allowed.

---

# 33. Skills UX requirements

Skills should be discoverable through `/skills`.

Recommended visual metadata:

```text
🔁 retry
📦 handoff
▶ continue-handoff
📋 handoff-status
ℹ retry-status
```

Skill names in `SKILL.md` should use the short local name so AGY/plugin namespacing produces:

```text
/agy-retry-hud:handoff
```

rather than a duplicated namespace.

---

# 34. Installation UX

Recommended installation flow:

```bash
node ./agy-retry-hud/setup.js install
```

Installer responsibilities:

- validate plugin structure;
- install or stage plugin;
- locate effective plugin directory;
- wire status line;
- preserve unrelated AGY settings;
- refuse overwrite of an unrelated status line unless explicitly forced;
- support uninstall/restore;
- run doctor checks.

Expected user workflow after install:

```bash
agy
```

No second manual `/statusline` command should normally be required when installer is used.

---

# 35. Doctor

`doctor` should validate:

- Node runtime requirement;
- AGY executable;
- AGY capabilities;
- plugin installed path;
- `plugin.json`;
- skills directory;
- hooks;
- status line wiring;
- config readability;
- state directory;
- portable handoff schema;
- optional read-only quota capability.

It must not consume a model turn.

---

# 36. Security

The project must:

- never log access tokens by default;
- never persist account credentials;
- redact diagnostic exports;
- avoid shell interpolation for user text;
- validate UTF-8 input;
- treat imported `.agyh` as untrusted input;
- prevent archive path traversal;
- verify checksums;
- reject malformed or unsupported handoff versions;
- scan portable content for likely secrets before export.

---

# 37. Testing requirements

Required automated areas:

## HUD

- wide layout;
- narrow layout;
- ANSI-aware width;
- Unicode width;
- same-row 5h + weekly quota;
- reset spacing;
- startup without conversation ID;
- quota provider/model filtering.

## Retry

- global on/off;
- session on/off/inherit;
- session override isolation;
- weekly hard block;
- stale weekly quota;
- transient backoff;
- 5h quota reset;
- duplicate error dedupe;
- TUI active race;
- worker lock.

## Handoff

- mechanical snapshot;
- semantic handoff;
- safe-point deferral;
- threshold transitions;
- native compaction cancel;
- manual creation;
- automatic creation;
- `.agyh` export/import;
- cross-path workspace rebinding;
- workspace mismatch;
- secret blocking;
- path traversal rejection;
- corrupted checksum rejection;
- conversation-independent continuation.

## Skills

- plugin package contains all skills;
- correct namespace metadata;
- deterministic CLI mapping;
- continue-handoff list and direct-file flow.

## Release

- plugin-only artifact;
- full-source artifact;
- extracted-artifact tests;
- Linux CI;
- macOS CI;
- Windows CI;
- Node 24;
- live AGY 1.2.14 smoke tests where available.

---

# 38. Acceptance criteria

v0.4.0 is code-complete only when:

1. Retry can be enabled/disabled globally.
2. Retry can be overridden for only the current conversation.
3. Weekly exhaustion blocks all automatic model retries.
4. HUD clearly exposes retry and handoff states.
5. 5h and weekly quota render on one row when width permits.
6. Manual `/agy-retry-hud:handoff` creates a valid handoff.
7. Automatic context handoff follows thresholds and safe-point rules.
8. AGY native compaction can cancel an armed rollover.
9. `/agy-retry-hud:continue-handoff` can list and continue a handoff.
10. `.agyh` works without the original absolute path.
11. `.agyh` works without the original conversation ID.
12. Imported workspace identity is validated.
13. Potential secrets are blocked from portable export by default.
14. Context rollover does not duplicate known side effects.
15. Weekly exhaustion may create a mechanical handoff but never a model turn.
16. Installer wires the native HUD automatically.
17. Plugin skills appear through AGY skill discovery.
18. Full automated regression suite passes from the packaged artifact.

Stable support claims for each OS require corresponding live evidence; missing live evidence must remain documented rather than inferred from fake-process CI.

---

# 39. Non-goals for v0.4.0

The following are explicitly out of scope:

- replacing AGY's native TUI;
- replacing AGY's internal context compaction algorithm;
- keyboard/PTY simulation to force TUI session switching;
- bypassing quota by automatically switching accounts;
- bypassing billing/auth/permission controls;
- copying full transcripts into handoff archives;
- automatically packaging secrets;
- assuming a native custom picker API exists where AGY does not expose one.

---

# 40. Final approved defaults

| Feature | Default |
|---|---|
| Native HUD | ON |
| Global automatic retry | ON |
| Conversation retry override | `inherit` |
| Retry transient API failure | ON |
| Retry eligible 5h quota | ON |
| Retry weekly exhaustion | OFF / hard blocked |
| Weekly safety threshold | 1% |
| Auto handoff | ON |
| Mechanical snapshot | 85% |
| Semantic handoff prepare | 90% |
| Auto rollover | 95% |
| Cancel rollover after compaction | below 80% |
| Semantic handoff | ON when quota permits |
| Mechanical fallback | ON |
| Rollover with unsafe pending tool | OFF |
| Auto-create new session after eligible rollover | ON |
| Force current TUI to new conversation | OFF |
| Portable handoff format | `.agyh` v1 |
| Full transcript copy | OFF |
| Portable dirty diff | opt-in portable mode |
| Automatic secret inclusion | OFF |
| 5h + weekly quota same row | ON when terminal width permits |

This document is the approved specification for the v0.4.0 implementation.


# 41. Stale Retry Protection / Retry Incident Lifecycle (v0.4.5)

Automatic retry is conversation-local and incident-local. Account/model quota availability only determines when an existing incident may be retried; it must never create retry intent for another conversation.

Each retryable terminal Stop creates `retryIncident` containing at minimum: `id`, `conversationId`, `fingerprint`, optional `executionNum`, `kind`, `status`, `createdAt`, and `updatedAt`.

Lifecycle statuses include: `ARMED`, `WAITING`, `DISPATCHING`, `RESOLVED`, `SUPERSEDED`, `SUCCEEDED`, `CANCELED`, `BLOCKED`, `NEEDS_USER`, `EXHAUSTED`, and `PAUSED_UNCERTAIN`.

Required invariants:

1. A normal Stop after an active incident resolves it when `autoDisarmIncidentOnSuccess=true`.
2. A newer `PreInvocation` in the same conversation supersedes any active pending incident.
3. Detached retry workers carry the incident id that created them.
4. A worker whose expected incident id does not match the current active incident returns `STALE_RETRY` and sends zero model messages.
5. Immediately before `session.send`, the worker re-validates the incident is still `DISPATCHING` and current.
6. Conversation A can never be armed because conversation B exhausted shared quota.
7. `requireCurrentIncidentBeforeDispatch=true` is the default and must be fail-safe.

Default config:

```json
{
  "retry": {
    "autoDisarmIncidentOnSuccess": true,
    "requireCurrentIncidentBeforeDispatch": true
  }
}
```
