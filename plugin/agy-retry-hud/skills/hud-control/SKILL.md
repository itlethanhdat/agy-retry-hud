---
name: hud-control
description: "Control agy-retry-hud visibility and functional mode without using a model turn for the actual local operation."
---

Use the deterministic local control plane.

- Show HUD and enable daemon/retry/handoff: `agy-retryctl hud on`
- Hide only the HUD while daemon/retry/handoff keep running: `agy-retryctl hud hide`
- Disable HUD plus daemon/retry/handoff: `agy-retryctl hud off`
- Inspect: `agy-retryctl hud status --json`

Do not simulate these state changes by sending a continuation prompt.
