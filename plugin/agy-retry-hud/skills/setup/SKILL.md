---
name: setup
description: Checks and repairs the agy-retry-hud installation: statusline, hooks, skills, config, launcher, handoff schema, and Node runtime compatibility. Use when the HUD is missing, partially configured, or after upgrading the plugin.
metadata:
  icon: "🛠️"
---

# AGY Retry HUD setup and repair

Use the deterministic setup control plane. Do not edit AGY settings, hooks, or plugin files by hand unless the deterministic repair command reports that manual intervention is required.

## Procedure

1. Run:

```bash
agy-retryctl setup status --json
```

If `agy-retryctl` is not on PATH, locate the installed `agy-retry-hud` plugin and run:

```bash
node <plugin-root>/setup.js doctor
```

2. Inspect all reported components, especially `installLocation`, `sharedConfigStaged`/`cliStaged`, and `skillsDiscoverable`:
   - plugin installation;
   - Node 24 compatibility;
   - native statusline wiring;
   - Stop hook wiring;
   - all packaged skills;
   - handoff schema;
   - `agy-retryctl` launcher;
   - user configuration validity.

3. If anything repairable is missing, run:

```bash
agy-retryctl setup repair --json
```

The repair operation may safely restore hooks, the HUD statusline, the `agy-retryctl` launcher, and a missing default config without overwriting unrelated user settings. If `agy-retryctl` is not on PATH, run `node <plugin-root>/setup.js repair` instead.

4. If another custom statusline is already configured, do **not** overwrite it silently. Report the conflict and ask the user before using:

```bash
agy-retryctl setup repair --force-statusline --json
```

5. If skills exist but `skillsDiscoverable` is false, run repair so the plugin is staged in one of AGY's supported global plugin discovery paths (`~/.gemini/config/plugins` or `~/.gemini/antigravity-cli/plugins`). Then run status again and report:
   - what was repaired;
   - what is healthy;
   - anything still requiring reinstall or user action.

6. If `reinstallRequired` is true, recommend reinstalling the current plugin package. Do not fabricate missing packaged skills/schema/runtime files.

The setup skill must not consume a model turn merely to test retry or quota behavior.
