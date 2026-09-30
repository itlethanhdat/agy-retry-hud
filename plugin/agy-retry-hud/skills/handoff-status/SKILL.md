---
name: handoff-status
description: Shows agy-retry-hud handoff policy, current handoff state, and available local handoffs without modifying the project.
metadata:
  icon: "📋"
---

# Handoff status

Run:

```bash
agy-retryctl handoff status --json
agy-retryctl handoff list --json
```

Summarize the effective global/conversation handoff policy and latest handoff. Do not create or consume a handoff.
