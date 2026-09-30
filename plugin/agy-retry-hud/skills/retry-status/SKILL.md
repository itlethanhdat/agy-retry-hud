---
name: retry-status
description: Shows agy-retry-hud effective retry policy for the current conversation, including weekly quota safety configuration.
metadata:
  icon: "ℹ️"
---

# Retry status

Run `agy-retryctl retry status --json` and report global state, conversation override, effective state, weekly safety threshold, native status, retry reason, next retry time, and current incident when present. If native status is `PAUSED_UNCERTAIN`, show the exact `reason` instead of rewriting it as `NEEDS_USER`. Do not change retry settings.
