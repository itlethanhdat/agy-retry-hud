---
name: handoff
description: Creates a safe continuation handoff for the current engineering task, including portable cross-device .agyh export when requested. Use before switching sessions/devices or when context is high.
metadata:
  icon: "📦"
---

# Handoff control and creation

Use `agy-retryctl` as the deterministic source of truth. A handoff is a checkpoint, not a transcript. It must be executable rather than narrative.

## Auto-handoff controls

If the user asks to enable/disable automatic handoff instead of creating a checkpoint, map the request exactly:

- global on: `agy-retryctl handoff on`
- global off: `agy-retryctl handoff off`
- this conversation on/off/inherit: `agy-retryctl handoff session on|off|inherit`
- status: `agy-retryctl handoff status --json`

After a change, run status again and report the effective conversation policy. Do not create a handoff unless the user asked for one.

## Create procedure

1. Run `agy-retryctl handoff create --json` to create the deterministic mechanical checkpoint and obtain its `handoffId` and directory.
2. Build a semantic `HANDOFF.md` for a future session that may have no access to this conversation. Include only verified information:
   - goal and explicit user requirements;
   - approved decisions/constraints;
   - completed work;
   - work in progress and first unfinished step;
   - workspace-relative relevant files;
   - tests/verification and failures;
   - uncertain side effects;
   - operations that must not be repeated;
   - exact next action.
3. Never include credentials, tokens, secrets, machine-specific absolute paths, or the full transcript. Distinguish facts from assumptions.
4. Write the semantic content to a temporary file inside the workspace, then run `agy-retryctl handoff semantic <handoff-id> --file <temp-file>`. Remove the temporary file afterward.
5. Validate with `agy-retryctl handoff validate <handoff-id> --json`.
6. If the user requested portability, run `agy-retryctl handoff export <handoff-id>` and report the `.agyh` path.
7. Offer these next actions without choosing for the user:
   1. stay in current conversation;
   2. start a new conversation from the handoff;
   3. export/copy the `.agyh` to another device.

Do not repeat project operations while generating the handoff.
