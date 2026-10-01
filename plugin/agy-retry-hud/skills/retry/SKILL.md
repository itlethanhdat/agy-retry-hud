---
name: retry
description: Controls agy-retry-hud automatic retry globally or for only the current Antigravity conversation. Use when the user wants retry on/off, session-only retry, retry status, or to clear a stale retry incident without disabling retry.
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
   - clear only the current retry incident while keeping retry enabled: `agy-retryctl retry clear`
   - inspect countdown/worker health without sending a model turn: `agy-retryctl retry scheduler --json`
3. Prefer exact conversation resolution. If status reports `conversationResolution: workspace-latest`, tell the user the conversation was inferred from cwd; in tmux the plugin should normally resolve from the current pane binding.
4. Run `agy-retryctl retry status --json` again and report effective state.
5. Never override `WEEKLY_BLOCKED`; weekly exhaustion is a hard safety gate.
6. Do not send a model prompt merely to test retry.

If `agy-retryctl` is not on PATH, locate the installed plugin and run `node <plugin-root>/dist/retryctl.js` with the same arguments.
