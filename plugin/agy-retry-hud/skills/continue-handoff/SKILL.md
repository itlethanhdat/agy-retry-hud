---
name: continue-handoff
description: Continues work safely from a local or portable agy-retry-hud handoff, including handoffs copied from another device. Use when resuming an existing .agyh checkpoint.
metadata:
  icon: "▶️"
---

# Continue from handoff

Treat every handoff as a checkpoint that must be reconciled with the current workspace.

## If no handoff was specified

1. Run `agy-retryctl handoff list --json`.
2. Present a concise numbered list with project, age/date, quality, status, and reason.
3. Ask the user to choose one item if the choice is ambiguous. Do not select a handoff silently.

## If a local ID or `.agyh` file was specified

1. For `.agyh`, run `agy-retryctl handoff import <file> --json`.
2. Run `agy-retryctl handoff validate <id-or-file> --json`.
3. Stop on workspace mismatch, invalid checksum/schema, missing required files, or security warnings.
4. Run `agy-retryctl handoff continue <id> --json` to obtain the continuation contract and handoff content.
5. Reconcile the actual workspace before continuing:
   - validate Git remote/repository identity;
   - inspect Git status and referenced files;
   - verify completed actions still exist;
   - resolve anything marked uncertain;
   - do not repeat completed side effects.
6. Continue from the first unfinished actionable step while preserving approved requirements and constraints.

All repository paths from the handoff are workspace-relative. Never reuse a source-device absolute path.
