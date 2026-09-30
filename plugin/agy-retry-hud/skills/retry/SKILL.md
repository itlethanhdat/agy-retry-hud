---
name: retry
description: Controls agy-retry-hud automatic retry globally or for only the current Antigravity conversation. Use when the user wants retry on/off, session-only retry, or retry status.
metadata:
  icon: "🔁"
---

# Retry control

Use the deterministic `agy-retryctl` command. Do not edit state files directly.

1. Run `agy-retryctl retry status --json` before changing anything.
2. Map the user's request exactly:
   - global on: `agy-retryctl retry on`
   - global off: `agy-retryctl retry off`
   - only this conversation: set global off, then `agy-retryctl retry session on`
   - conversation on/off/inherit: `agy-retryctl retry session on|off|inherit`
3. Run `agy-retryctl retry status --json` again and report effective state.
4. Never override `WEEKLY_BLOCKED`; weekly exhaustion is a hard safety gate.
5. Do not send a model prompt merely to test retry.

If `agy-retryctl` is not on PATH, locate the installed plugin and run `node <plugin-root>/dist/retryctl.js` with the same arguments.
