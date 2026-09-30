# AGY Retry HUD v0.4.5

Native HUD + Policy-Controlled Auto Retry + Portable Handoff for the **Google Antigravity CLI (`agy`)**.

[English](README.md) | [Tiếng Việt](README.vi.md) | [Build Guide](BUILD.md)

---

`agy-retry-hud` enhances your Antigravity workflow while **strictly preserving the native AGY TUI**. It uses the native status line to display context, 5-hour quota, and weekly quota metrics; a native `Stop` hook to track errors; a background worker for controlled retries; and the `agy-retryctl` CLI plus plugin skills for manual/automatic task handoffs.

> **Release Status (v0.4.5):** Implementation complete and offline-verified. Target runtime is Node.js 24.x, and target AGY version is 1.2.14. Native Windows status-line command wiring includes PowerShell-encoded quoting safety. Live authenticated AGY runs on macOS/Windows are evaluated against release gates without counting synthetic offline tests as live verification.

---

## Key Features

- **Native HUD in `agy`**: Rendered directly in AGY's status line without taking over or wrapping the terminal TUI.
- **Combined Dual Quota Display**: 5-hour and weekly quotas shown on a single line on wide terminals; adaptive fallback on narrow terminals.
- **Granular Retry Policies**: Global ON/OFF and conversation-level override (`inherit | on | off`).
- **"Retry Only This Session"**: Configure global OFF with conversation override ON.
- **Weekly Quota Hard Block**: When weekly quota is `≤ 1%`, automatic retry is permanently blocked to prevent exhausting accounts.
- **Safe API & Quota Backoff**: Automatic backoff with deadlines, locks, and deduplication for transient API errors and eligible 5h quota resets.
- **Stale Retry Protection**: Retry intents are bound to the exact conversation and incident; any newer turn or successful Stop automatically disarms old retries.
- **Graduated Auto-Handoff**: Warning at 80%, mechanical snapshot at 85%, semantic summary at 90%, rollover at 95%.
- **Context Compaction Awareness**: Native AGY context compaction dropping below 80% automatically disarms armed rollovers.
- **Manual & Portable Handoff**: Export task checkpoints to standalone portable `.agyh` archives across directories or machines.
- **Cross-Device Portability**: Handoffs do not depend on source absolute paths or original conversation IDs.
- **Security & Integrity**: Git workspace identity, SHA-256 checksums, ZIP path-traversal prevention, and automatic secret pattern redaction.
- **Native Skills**: Bundled skills discovered via `/skills` inside AGY (`/agy-retry-hud:retry`, `/agy-retry-hud:handoff`, etc.).

---

## HUD Layouts

### Wide Terminal (≥ 90 columns)

```text
╭─ ● WORKING │ Gemini 3.8 Flash (High) │ Pro │ git:main*
├─ ctx   █████████░ 91% used 910k/1M     │ handoff:READY
╰─ quota 5h ███░░░░ 19% ↻ 1h55m │ week ████░░░ 44% ↻ 1d20h │ retry:SESSION
```

### Compact HUD (Default in v0.4.5)

```text
╭─ ● READY │ Gemini 3.8 Flash (High) │ Pro │ retry:ON │ handoff:OFF
╰─ ctx █░░░░░░░ 4% 40k/1M │ 5h ████████ 99% ↻ 4h49m │ week █░░░░░░░ 6% ↻ 19h38m
```

### Narrow Terminal (< 90 columns)

```text
╭─ ● READY │ Gemini 3.8 Flash │ Pro
├─ ctx  █████████░ 91% │ handoff:READY
├─ 5h   ███░░░░░░ 19% ↻ 1h55m
╰─ week ████░░░░░ 44% ↻ 1d20h
```

Column alignment uses true terminal display width calculations (handling Unicode glyphs and ANSI colors) so borders never misalign.

---

## Requirements

- **Node.js**: `24.x` (target: Node `24.21.0` or `>=24 <25`).
- **Antigravity CLI**: `agy` (tested on `1.2.14`).
- **OS**: Linux, macOS, or Windows (PowerShell 5.1+ or PowerShell 7+).
- **Dependencies**: Zero runtime third-party npm packages.

---

## Quick Start & Installation

### Recommended: Plugin-Only Archive

Download and extract `agy-retry-hud-plugin-v0.4.5.zip`, then execute:

```bash
node ./agy-retry-hud/setup.js install
```

The installer will:
1. Validate the plugin with `agy plugin validate`.
2. Install the plugin into AGY plugins directory.
3. Wire the native `statusLine` configuration safely.
4. Wire `Stop` and `PreInvocation` hooks.
5. Create the `agy-retryctl` command launcher in PATH.

If you already use a custom status line and want to replace it:

```bash
node ./agy-retry-hud/setup.js install --force-statusline
```

Restart `agy`, then verify:

```bash
agy-retryctl retry status
agy-retryctl handoff status
```

Inside AGY, run:
```text
/hooks
/skills
```

---

### Installing from Source Repository

```bash
git clone https://github.com/itlethanhdat/agy-retry-hud.git
cd agy-retry-hud
node ./src/setup.js install
```

The installer automatically detects the nested plugin directory `./plugin/agy-retry-hud`.

---

## Building from Source

To build, verify, and run the test suite:

```bash
# 1. Build plugin dist bundle
npm run build:plugin

# 2. Verify plugin package structure and schemas
npm run verify:plugin-package

# 3. Run automated unit and integration tests
npm test
```

For comprehensive packaging and build details, see [BUILD.md](BUILD.md).

---

## Retry Controls

Control retry behavior via CLI or in-session skills:

```bash
# Global configuration
agy-retryctl retry on
agy-retryctl retry off
agy-retryctl retry status

# Current conversation override
agy-retryctl retry session on
agy-retryctl retry session off
agy-retryctl retry session inherit
```

### "Only This Session" Mode

To prevent unexpected retries across other tasks while enabling retry for the active conversation:

```bash
agy-retryctl retry off
agy-retryctl retry session on
```

Or using the AGY skill:

```text
/agy-retry-hud:retry session on
```

### Weekly Quota Hard Block

When weekly quota drops to `≤ 1%`, the status line indicates:

```text
retry:WEEKLY BLOCK
```

The background worker will not dispatch any prompt turns until quota has replenished.

---

## Stale Retry Protection & Incident Lifecycle

Retries are strictly tied to a specific unresolved incident in the exact conversation:

```text
API / Quota Error
  → Create incident: WAITING
  → Newer successful Stop event       => Incident RESOLVED (no retry)
  → Newer user turn / PreInvocation   => Incident SUPERSEDED (no retry)
  → Worker timeout / stale ID         => Disarmed as STALE_RETRY
  → Incident valid + quota healthy    => Dispatch retry turn
```

Both `Stop` and `PreInvocation` hooks coordinate to prevent phantom retries when you continue working or start another task.

---

## Task Handoff & Rollover

### Default Thresholds

```text
80%  Warning indicator in status line
85%  Mechanical state snapshot
90%  Semantic handoff summary prepared
95%  Rollover eligible (safe point required: idle agent, no pending confirmation)
<80% Armed rollover canceled (after AGY native context compaction)
```

### Manual Handoff

Inside AGY:
```text
/agy-retry-hud:handoff
/agy-retry-hud:handoff portable
```

Via CLI:
```bash
agy-retryctl handoff create
agy-retryctl handoff create --portable
```

To include untracked work-in-progress files:
```bash
agy-retryctl handoff create --portable \
  --include-untracked notes.md \
  --include-untracked src/patch.js
```

### Resuming Work on Another Device

1. On **Device A**:
   ```bash
   agy-retryctl handoff create --portable
   # Output: myproject-<handoff-id>.agyh
   ```
2. Copy `.agyh` to **Device B**.
3. Open the target git repository and run:
   ```text
   /agy-retry-hud:continue-handoff /path/to/myproject-<handoff-id>.agyh
   ```
   Or via CLI:
   ```bash
   agy-retryctl handoff import /path/to/myproject-<handoff-id>.agyh
   ```

---

## Bundled Skills

| Skill | Description |
|---|---|
| `/agy-retry-hud:retry` | Configure or toggle retry policies globally or per session |
| `/agy-retry-hud:retry-status` | Display effective retry status and quota details |
| `/agy-retry-hud:handoff` | Create manual local or portable task handoff checkpoints |
| `/agy-retry-hud:continue-handoff` | Resume work from a local handoff or `.agyh` file |
| `/agy-retry-hud:handoff-status` | View recent handoff checkpoints and thresholds |
| `/agy-retry-hud:setup` | Verify and repair plugin status line, hooks, and launcher |

---

## Configuration

Default location:
- **Linux/macOS**: `~/.config/agy-retry-hud/config.json`
- **Windows**: `%APPDATA%\agy-retry-hud\config.json`
- Custom path via environment variable: `AGY_RETRY_HUD_CONFIG`

Example configuration (`config.example.json`):

```json
{
  "retry": {
    "enabled": true,
    "stopWhenWeeklyExhausted": true,
    "weeklyRemainingThreshold": 0.01,
    "autoDisarmIncidentOnSuccess": true,
    "requireCurrentIncidentBeforeDispatch": true
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
  },
  "hud": {
    "compact": true
  }
}
```

---

## Diagnostics & Doctor

Run the health check after installation:

```bash
agy-retryctl setup status --json
```

Or run repair to restore missing hook or status line entries:

```bash
agy-retryctl setup repair --json
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
