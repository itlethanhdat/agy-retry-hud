# Project instructions — agy-retry-hud

- Read `spec.md` and `plan.md` before product changes. v0.4.0 approved behavior is normative.
- Read `docs/V0.4-EXECUTION.md` before claiming a workstream or release gate complete.
- No runtime third-party dependencies without a documented reason.
- Never shell-interpolate prompt/user text.
- Run `npm test` after shared-state, retry, handoff, HUD, skill, setup, or packaging changes.
- For bug fixes, reproduce the failure first and keep the regression test.
- Respect exact conversation identity. Never silently fall back to a recent conversation for automatic retry.
- Weekly quota hard block must never be bypassed by retry/session overrides.
- Unknown/ambiguous tool outcomes stop automatic continuation.
- Manual and automatic handoff must use the same HandoffEngine/schema/security rules.
- Portable handoffs must not depend on source absolute paths or source conversation IDs.
- Treat imported `.agyh` as untrusted: validate schema/checksums/paths/workspace before use.
- Never silently include credentials/secrets in portable artifacts.
- HUD rendering must be local-only and side-effect free; redraw must not cause model/quota polling.
- Preserve the native AGY TUI. Do not add keyboard/PTY simulation to force conversation switching.
- Fixtures must label synthetic vs observed provenance. Do not claim live AGY or OS verification from offline tests.
- Never commit runtime state, credentials, raw transcripts, or user config.
