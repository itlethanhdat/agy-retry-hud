---
name: daemon-control
description: "Start, stop, restart, enable, disable, or inspect the singleton agy-retry-hud background daemon."
---

Use `agy-retryctl daemon <command>`.

Supported commands: `start`, `stop`, `restart`, `status`, `enable`, `disable`.
The daemon is singleton per OS user and must not be started once per AGY conversation.
Prefer `status --json` when reporting diagnostics.
