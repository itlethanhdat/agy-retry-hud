# Review report — v0.4.0

Date: 2026-09-30

## Architecture review

v0.4.0 retains the native AGY TUI/status-line architecture and extends it with a deterministic control plane and one shared HandoffEngine. Skills are UX/orchestration; persistent state remains owned by `agy-retryctl`/core modules.

## High-risk cases addressed

1. **Weekly quota retry loop** — weekly <= safety threshold becomes `WEEKLY_BLOCKED`; automatic model sends stop.
2. **Session override leakage** — overrides are keyed by exact conversation ID.
3. **Context rollover duplicates side effects** — rollover waits for safe idle state and blocks on pending tool/input/confirmation.
4. **Native compaction makes rollover unnecessary** — dropping below cancel threshold disarms rollover.
5. **Portable handoff bound to machine path** — continuation validates normalized Git identity and uses workspace-relative paths.
6. **Portable handoff bound to old conversation** — source conversation is provenance only; continuation can start in a fresh conversation.
7. **Archive attacks/corruption** — store-only ZIP reader enforces safe paths, file/size bounds, CRC and SHA-256 checksums.
8. **Secrets accidentally exported** — denylist + text secret scanner + explicit-only selected untracked inclusion.
9. **Binary/unbounded WIP inclusion** — selected untracked files are limited, regular text files only, <=5 MiB each.
10. **Status-line side effects** — HUD redraw remains local and does not poll the model/quota API.
11. **TUI/new-session switching** — no keyboard/PTY simulation; background rollover stores the new conversation ID.
12. **Installer half-configured** — recommended setup installs plugin, wires status line, and creates `agy-retryctl` launcher.

## Deliberate limits

- v0.4 does not replace AGY native context compaction.
- v0.4 does not auto-switch accounts/models to evade quota.
- v0.4 does not silently include all untracked files.
- v0.4 does not claim native picker UI for handoff selection; the skill renders numbered choices.
- v0.4 does not claim live Windows/macOS/AGY verification from synthetic tests.

See `docs/V0.4-EXECUTION.md` for release evidence and pending external gates.
