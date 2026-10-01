# Install agy-retry-hud v0.4.2

## Recommended — plugin-only archive

Extract `agy-retry-hud-plugin-v0.4.2.zip`, then:

```bash
node ./agy-retry-hud/setup.js install
```

This validates/installs the plugin with `agy plugin`, wires the native status line, preserves unrelated settings, and creates the `agy-retryctl` launcher.

If another custom status line exists:

```bash
node ./agy-retry-hud/setup.js install --force-statusline
```

Restart `agy`, then verify:

```bash
agy-retryctl retry status
agy-retryctl handoff status
```

Inside AGY:

```text
/hooks
/skills
```

Expected plugin skills:

```text
/agy-retry-hud:retry
/agy-retry-hud:handoff
/agy-retry-hud:continue-handoff
/agy-retry-hud:handoff-status
/agy-retry-hud:retry-status
```

## Full project archive

From the v0.4.2 source root:

```bash
node ./src/setup.js install
```

The plugin root is `./plugin/agy-retry-hud`; setup auto-detects it.

## Native AGY install only

This works for plugin assets/hooks:

```bash
agy plugin validate ./agy-retry-hud
agy plugin install ./agy-retry-hud
```

A plain `agy plugin install` may not wire your custom status line or create the `agy-retryctl` launcher. Prefer `setup.js install` for the complete v0.4 experience.

## Doctor

Typical staged location:

```bash
node ~/.gemini/antigravity-cli/plugins/agy-retry-hud/setup.js doctor
```

Some builds may use:

```bash
node ~/.gemini/config/plugins/agy-retry-hud/setup.js doctor
```

`agy plugin list` shows the effective plugin location.

## Runtime requirements

- Node.js 24.x.
- AGY capabilities for plugins, hooks, status line, skills, and headless conversation JSON.
- Known v0.4 target: AGY 1.2.14.

## Windows upgrade / repair

If AGY reports a module path similar to:

```text
C:\workspace\"C:\Users\...\agy-retry-hud\dist\native-entry.js"
```

that is the v0.4.0 direct-path quoting bug. v0.4.2 uses a PowerShell `-EncodedCommand` launcher for both status-line and installed Stop-hook commands. Re-run the installer with:

```powershell
node .\agy-retry-hud\setup.js install --force-statusline
```

Then restart `agy`.

## v0.4.2 HUD and setup skill

The native HUD uses a fixed visual metric grid. Context and quota percentages change color by severity, and 5h/weekly quota share one row when the terminal is wide enough.

Use the new setup skill inside AGY:

```text
/agy-retry-hud:setup
```

Or use the deterministic control plane:

```bash
agy-retryctl setup status --json
agy-retryctl setup repair --json
```

`setup repair` restores missing agy-retry-hud statusline wiring, Stop hook wiring, the `agy-retryctl` launcher and a missing default config. It does not silently overwrite an unrelated custom statusline; use `--force-statusline` only after explicit approval.


## Retry incident safety

v0.4.5 installs both `Stop` and `PreInvocation` hooks. `Stop` arms/resolves retry incidents; `PreInvocation` supersedes stale pending retries when the user or AGY starts a newer turn in the same conversation. Run `setup.js repair` after upgrading so both hooks are wired.


## v0.4.7 tmux / multiple CLI notes

`agy-retryctl` now prefers exact terminal binding (for example `TMUX_PANE`) before workspace-latest conversation inference. Use `--conversation <id>` for automation when exact identity is known.

If AGY warns that a conversation is already open in another CLI instance, agy-retry-hud blocks automatic retry for that conversation (`retry:MULTI-CLI`) until the duplicate-session conflict is resolved. `agy-retryctl retry clear` clears a stale incident without turning retry off.


## v0.4.8 quota retry diagnostics

For individual quota errors such as `Individual quota reached ... Resets in 2h23m10s`, check:

```bash
agy-retryctl retry status --json
```

Expected after the final Stop hook:

```json
{
  "nativeStatus": "WAIT_QUOTA",
  "lastStop": {
    "classification": "quota",
    "classificationSource": "payload"
  },
  "nextRetryAt": 0
}
```

If AGY omits the Stop error string but the 5h statusline bucket is exhausted, `classificationSource` may be `telemetry-5h`.


## v0.4.9 scheduler diagnostics

Sau khi gặp quota/API transient error, kiểm tra worker/timer mà không gửi model turn:

```bash
agy-retryctl retry scheduler --json
```

Nếu HUD hiển thị `sched:LOST` hoặc `sched:STALE`, countdown vẫn có thể còn trong persistent state nhưng worker không còn được coi là healthy. Dùng output này để phân biệt timer thật với state cũ.
