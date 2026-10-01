---
name: retry-status
description: Shows agy-retry-hud effective retry policy for the current conversation, including weekly quota safety configuration.
metadata:
  icon: "ℹ️"
---

# Retry status

Run `agy-retryctl retry status --json` and report conversation id, `conversationResolution`, `multiCli`, global state, conversation override, effective state, weekly safety threshold, native status, retry reason, next retry time, current incident, and `scheduler` diagnostics when present. For a waiting retry, report countdown (`retryIn`), reason label (`503`, `QUOTA`, etc.), attempt/max, `deadlineSource`, `workerAlive`, and scheduler status. You may also run `agy-retryctl retry scheduler --json` for a focused local-only scheduler check; it must not send a model turn. If native status is `PAUSED_UNCERTAIN`, show the exact `reason` instead of rewriting it as `NEEDS_USER`. Do not change retry settings.
