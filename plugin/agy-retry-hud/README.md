# AGY Retry HUD v0.5.1

Native HUD + policy-controlled Auto Retry + Portable Handoff cho **Antigravity CLI (`agy`)**.

`agy-retry-hud` giữ nguyên TUI gốc của AGY. Plugin dùng native status line để hiển thị context/quota/trạng thái, Stop hook để phát hiện lỗi, worker nền để retry có kiểm soát, và `agy-retryctl` + plugin skills để quản lý retry/handoff.

> **Release status:** v0.5.1 implementation complete / offline-verified. Windows status-line command wiring was hardened after a live AGY 1.2.14 quoting failure on native Windows. Target runtime là Node.js 24.x và known target AGY là 1.2.14. Live authenticated AGY, macOS và Windows vẫn là release-evidence gates nếu chưa chạy trên máy tương ứng; project không coi synthetic tests là live verification.



## v0.5.1 statusline fast-path hardening

AGY 1.2.14 can kill a custom statusline process if it does too much work or fails to terminate promptly. v0.5.1 keeps the render callback intentionally small:

```text
read AGY payload
→ lightweight daemon ensure
→ fast ephemeral telemetry update (no fsync)
→ read local retry/control state
→ render
→ flush stdout
→ exit
```

Automatic handoff scheduling is no longer performed by the statusline process. The singleton daemon consumes telemetry and owns that scheduling. Durable retry/handoff state still uses atomic fsync-backed writes where correctness matters.

If AGY logs `statusline: command failed: signal: killed`, upgrade to v0.5.1 and run `agy-retryctl doctor --json`.

## v0.5.0 — Embedded Singleton Daemon

v0.5.0 chuyển scheduler từ mô hình detached worker theo incident sang **một daemon duy nhất cho mỗi user/state root**, không cần systemd/launchd/Windows Service.

```text
AGY session A ─┐
AGY session B ─┼──> agy-retry-hud daemon (singleton)
AGY session C ─┘          │
                          ├─ retry scheduler
                          ├─ quota deadline/backoff
                          ├─ handoff worker orchestration
                          └─ heartbeat/runtime health
```

Daemon được ensure tự động ở callback sớm nhất mà public AGY plugin API hiện có: native statusline activation, `PreInvocation`, và `Stop`. AGY hiện không công bố `SessionStart` hook riêng, nên plugin không giả lập một hook không tồn tại.

Các lệnh local, không tạo model turn:

```bash
agy-retryctl daemon start
agy-retryctl daemon stop
agy-retryctl daemon restart
agy-retryctl daemon status --json

agy-retryctl hud on
agy-retryctl hud hide
agy-retryctl hud off
agy-retryctl hud status --json

agy-retryctl doctor --json
```

Semantics:

| Mode | HUD | Daemon | Retry | Handoff |
|---|---:|---:|---:|---:|
| `hud on` | on | on | on | on |
| `hud hide` | hidden | unchanged/on | unchanged/on | unchanged/on |
| `hud off` | off | off | off | off |

Daemon dùng adaptive scan interval: idle 10s, WAIT_QUOTA 30s, WAIT_BACKOFF 5s, gần deadline 1s, active dispatch 500ms. Heartbeat vẫn được ghi riêng theo cấu hình mặc định 5s.

### Retry không phụ thuộc HUD repaint

Khi AGY TUI không redraw statusline, **daemon vẫn theo dõi deadline và tự retry**. HUD countdown được tính từ local state mỗi lần AGY gọi statusline. Public plugin API hiện không cung cấp primitive an toàn để ép TUI redraw từ process nền, vì vậy text đang nhìn trên màn hình có thể đứng yên khi AGY hoàn toàn idle; điều này không đồng nghĩa scheduler dừng. Dùng:

```bash
agy-retryctl daemon status --json
agy-retryctl retry scheduler --json
```

để kiểm tra trạng thái nền thực tế.

### Migration v0.4.x

Config cũ được merge với defaults v0.5. Waiting incident cũ được daemon rebind sang incident id mới để detached worker v0.4 trở thành stale trước khi daemon nhận quyền scheduler; deadline/counter hiện có được giữ lại.

Xem `MIGRATION-v0.5.md`.

## Tính năng chính

- Native HUD ngay trong `agy`, không thay TUI.
- 5h + weekly quota cùng một dòng khi terminal đủ rộng; adaptive fallback khi hẹp.
- Retry global ON/OFF và override riêng conversation: `inherit | on | off`.
- “Retry only this session”: global OFF + conversation override ON.
- Weekly quota `<= 1%` là **hard block**: không tự retry, không wake theo vòng 5h.
- Retry transient API + eligible 5h quota với deadline/backoff, lock và dedupe.
- Stale Retry Protection: retry intent is bound to the exact conversation/failed incident; a newer successful Stop or model invocation automatically disarms the old retry.
- Auto handoff: warning 80%, mechanical snapshot 85%, semantic prepare 90%, rollover 95%.
- Native compaction kéo context xuống dưới 80% sẽ hủy rollover đang arm.
- Manual handoff bằng skill `/agy-retry-hud:handoff`.
- Continue handoff bằng `/agy-retry-hud:continue-handoff`.
- Portable `.agyh` chạy được trên thiết bị/path/conversation khác.
- Handoff không phụ thuộc source conversation ID hay absolute workspace path.
- Git workspace identity + checksum + ZIP path-traversal protection + secret blocking.
- Skills được package trong plugin và discover qua `/skills`.

## HUD v0.4

Wide terminal:

```text
╭─ ● WORKING │ Gemini 3.7 Flash (Medium) │ Pro │ git:main*
├─ ctx   █████████░ 91% used 910k/1M     │ handoff:READY
╰─ quota 5h ███░░░░ 19% ↻ 1h55m │ week ████░░░ 44% ↻ 1d20h │ retry:SESSION
```

Narrow terminal:

```text
╭─ ● READY │ Gemini 3.7 Flash │ Pro
├─ ctx  █████████░ 91% │ handoff:READY
├─ 5h   ███░░░░░░ 19% ↻ 1h55m
╰─ week ████░░░░░ 44% ↻ 1d20h
```

Renderer căn theo **terminal display width** thay vì `string.length`, nên ANSI color/Unicode/progress bar không làm lệch cột. Reset luôn có khoảng cách `↻ 1h55m`, không dính `↻1h55m`.

## Yêu cầu

- Node.js **24.x**.
- Antigravity CLI `agy`; known target v0.4: **1.2.14**.
- `agy` đã đăng nhập trên máy dùng live features.
- Linux/macOS/Windows.

Không có npm runtime dependency.

## Cài đặt khuyến nghị

Tải và giải nén **plugin-only archive**, sau đó:

```bash
node ./agy-retry-hud/setup.js install
```

Installer sẽ:

1. `agy plugin validate`;
2. `agy plugin install`;
3. tìm plugin đã stage;
4. wire native `statusLine`;
5. giữ nguyên AGY settings khác;
6. tạo launcher `agy-retryctl`.

Nếu đã có HUD khác, installer không ghi đè trừ khi dùng:

```bash
node ./agy-retry-hud/setup.js install --force-statusline
```

Sau đó restart:

```bash
agy
```

Kiểm tra:

```bash
agy-retryctl retry status
agy-retryctl handoff status
```

Trong AGY:

```text
/hooks
/skills
```


### Windows status-line wiring

On native Windows, v0.4.2 no longer writes a direct command such as:

```text
node "C:\\Users\\...\\native-entry.js" statusline
```

AGY 1.2.14 can preserve those quote characters while splitting the command, causing Node to resolve a bogus path relative to the current workspace. v0.4.2 writes a quote-safe PowerShell `-EncodedCommand` launcher instead. The encoded launcher reads AGY status-line JSON from stdin and forwards it to the installed Node runtime, so paths containing spaces are safe as well. The installed Stop hook is rewritten with the same Windows-safe launcher.

If upgrading from v0.4.0, rerun:

```powershell
node .\agy-retry-hud\setup.js install --force-statusline
```

then start a fresh `agy` session.

### Full source archive

Nếu dùng full project:

```bash
node ./src/setup.js install
```

Setup tự nhận plugin root `./plugin/agy-retry-hud`.

## Retry controls

```bash
# Global
agy-retryctl retry on
agy-retryctl retry off
agy-retryctl retry status

# Current AGY conversation
agy-retryctl retry session on
agy-retryctl retry session off
agy-retryctl retry session inherit
```

“Only this session”:

```bash
agy-retryctl retry off
agy-retryctl retry session on
```

Skill tương ứng:

```text
/agy-retry-hud:retry
/agy-retry-hud:retry on
/agy-retry-hud:retry off
/agy-retry-hud:retry session on
/agy-retry-hud:retry status
```

Weekly quota còn `<= 1%` mặc định chuyển sang:

```text
retry:WEEKLY BLOCK
```

và worker **không gửi model turn**. Nếu weekly telemetry stale/unknown trước quota retry, worker chỉ cho phép read-only refresh; vẫn unknown thì `NEEDS_USER`.






## v0.4.10 AGY 1.2.14 compatibility fixes

This release fixes two runtime errors observed in live AGY 1.2.14 logs:

- `skills/setup/SKILL.md` could fail YAML parsing because its description contained an unquoted colon.
- The PreInvocation hook incorrectly returned `terminationBehavior`, a field AGY accepts for PostInvocation but not PreInvocation.

PreInvocation now emits exactly:

```json
{
  "injectSteps": []
}
```

The statusline stdin reader also stops waiting as soon as a complete JSON object is available. This avoids depending on stdin EOF and adds a bounded fallback for runner stalls.

After upgrading, run:

```bash
node ~/.gemini/config/plugins/agy-retry-hud/setup.js repair
node ~/.gemini/config/plugins/agy-retry-hud/setup.js doctor
```

`doctor` now reports invalid skill frontmatter through `skillFrontmatter` and `skillsReady=false`.

## v0.4.9 Retry countdown + scheduler health

HUD không chỉ hiển thị rằng retry đang bật. Khi có một retry incident đang chờ, header hiển thị **countdown, loại lỗi, attempt và scheduler health**:

```text
╭─ ● READY │ Gemini 3.8 Flash │ retry:WAIT 00:59 · 503 · 1/6 · sched:OK
╰─ ctx ██░░░░░░ 24% │ 5h ███████░ 82% │ week ██████░░ 71%
```

Quota dài:

```text
╭─ ● READY │ Gemini 3.8 Flash │ retry:WAIT 02:23:10 · QUOTA · 1/2 · sched:OK
╰─ ctx ██░░░░░░ 24% │ 5h ░░░░░░░░ 0% │ week ██████░░ 71%
```

Scheduler health:

- `sched:OK`: detached worker PID còn sống và heartbeat còn mới.
- `sched:STALE`: worker còn sống nhưng heartbeat đã quá hạn.
- `sched:LOST`: worker không còn sống hoặc scheduler/incident/deadline không khớp.
- `CHECK`: deadline đã tới, worker đang kiểm tra policy/quota/activity/multi-CLI.
- `DISPATCH`: worker đã qua safety gates và đang chuẩn bị gửi continuation.
- `RUNNING`: continuation đã được gửi và đang chờ terminal result.

Countdown chỉ tính từ persistent `nextRetryAt`; HUD không gọi model và không poll `/usage` mỗi giây. Worker heartbeat được cập nhật local trong lúc chờ.

Inspect scheduler trực tiếp:

```bash
agy-retryctl retry scheduler
agy-retryctl retry scheduler --json
```

Ví dụ JSON:

```json
{
  "nativeStatus": "WAIT_BACKOFF",
  "scheduler": {
    "status": "OK",
    "retryIn": "00:59",
    "retryLabel": "503",
    "attempt": 1,
    "maxAttempts": 6,
    "deadlineSource": "backoff",
    "workerAlive": true
  }
}
```

Các nguồn deadline:

- `server`: quota reset được lấy trực tiếp từ lỗi server.
- `telemetry-5h`: Stop error thiếu text nhưng statusline xác nhận bucket 5h đã cạn.
- `fallback`: individual quota xác định nhưng không có reset đáng tin cậy, dùng fallback 5h.
- `server-delay`: transient API có retry delay rõ ràng.
- `backoff`: transient API dùng exponential backoff (`1m → 2m → 4m → 8m → 15m...`).

## v0.4.8 Individual quota retry hardening

AGY can report an exhausted individual quota as:

```text
Individual quota reached. Please upgrade your subscription to increase your limits.
Resets in 2h23m10s.
```

v0.4.8 treats this as an eligible individual/5h quota incident and schedules the retry at the advertised reset plus the configured safety margin.

A retryable quota/API error can be armed even when the Stop hook reports `fullyIdle=false`; this matters when AGY still has background/subagent activity. The worker does **not** blindly send later: it re-validates terminal activity, incident identity, weekly quota, policy state, and multi-CLI safety immediately before dispatch.

If AGY emits `terminationReason=error` but omits the Stop `error` string, the plugin may use structured statusline telemetry as a conservative fallback only when the active 5h bucket is actually exhausted and has a future reset.

Debug with:

```bash
agy-retryctl retry status --json
```

The output now includes `lastStop.classification` and `lastStop.classificationSource` (`payload` or `telemetry-5h`).


## v0.4.7 exact-conversation and multi-CLI retry safety

Manual AGY activity now always wins over stale automation state. A new `PreInvocation` in the same conversation supersedes retry incidents/states such as `WAIT_QUOTA`, `WAIT_BACKOFF`, `NEEDS_USER`, and `PAUSED_UNCERTAIN`, clears `nextRetryAt`, and returns retry state to `IDLE` without disabling the retry policy.

Clear only the current incident while keeping retry enabled:

```bash
agy-retryctl retry clear
```

For scripts or tmux workflows, prefer an exact id when needed:

```bash
agy-retryctl retry clear --conversation <conversation-id>
agy-retryctl retry status --conversation <conversation-id> --json
```

`retry status --json` now reports how the conversation was resolved:

```json
{
  "conversationId": "...",
  "conversationResolution": "explicit|terminal|workspace-latest",
  "multiCli": false,
  "activeTerminalInstances": 1
}
```

In tmux, `TMUX_PANE` is used to bind the local control command to the conversation currently rendered in that pane before falling back to `cwd + latest telemetry`. Supported terminal-instance hints also include Windows Terminal, WezTerm, Kitty, Terminal.app, GNOME Terminal, and Konsole where their environment identifiers are available.

If the same conversation is observed in more than one active CLI instance, automatic retry is fail-safe blocked:

```text
retry:MULTI-CLI
```

No background `continue` is sent until the conflict is resolved by closing/forking the duplicate CLI session or the user manually continues. This complements AGY's own "Conversation already open" warning.

## v0.4.6 stale uncertainty self-healing

A `Stop` event with `fullyIdle=false` means AGY still has native/background work. v0.4.6 no longer turns that event into `PAUSED_UNCERTAIN`; retry classification is deferred until a fully-idle Stop.

When upgrading from v0.4.5, a conversation that already contains the legacy reason `stop hook fired while background work is still active` is self-healed to `IDLE` as soon as status-line telemetry for the same conversation appears again. A genuine uncertain background retry remains visible as `retry:UNCERTAIN`, while only actual user-action states render as `retry:NEEDS USER`.

`agy-retryctl retry status --json` now includes `reason` for diagnostics.

## Stale Retry Protection / Incident Lifecycle

Retry không được kích hoạt chỉ vì quota của account đã reset. Mỗi retry phải có một **incident đang còn hiệu lực** của đúng conversation.

Lifecycle chính:

```text
API/quota error
→ retry incident WAITING
→ normal Stop/SUCCESS mới hơn     => RESOLVED, không retry
→ PreInvocation/manual turn mới   => SUPERSEDED, không retry
→ worker cũ / incident id cũ      => STALE_RETRY, không gửi prompt
→ incident vẫn current + đủ gate  => dispatch đúng conversation
```

Ví dụ hai session:

```text
Session A: công việc đã hoàn tất, retry incident = none/resolved
Session B: quota/API error, retry incident = WAITING
quota reset → chỉ B được xem xét retry; A không nhận `continue`
```

Mặc định:

```json
{
  "retry": {
    "autoDisarmIncidentOnSuccess": true,
    "requireCurrentIncidentBeforeDispatch": true
  }
}
```

Plugin dùng cả `Stop` và `PreInvocation` hooks để vô hiệu hóa retry cũ khi conversation đã có tiến triển mới.

## Auto handoff controls

```bash
# Global
agy-retryctl handoff on
agy-retryctl handoff off
agy-retryctl handoff status

# Current conversation
agy-retryctl handoff session on
agy-retryctl handoff session off
agy-retryctl handoff session inherit
```

Skill `/agy-retry-hud:handoff` cũng hiểu yêu cầu bật/tắt auto-handoff và ánh xạ về `agy-retryctl`.

### Threshold mặc định

```text
80%  warning
85%  mechanical snapshot
90%  semantic handoff preparation
95%  rollover eligible
<80% cancel armed rollover after native AGY compaction
```

Handoff/rollover chỉ chạy tại safe point: agent idle, không task, không pending input, không tool confirmation và không unresolved side effect.

## Manual handoff

Trong AGY:

```text
/agy-retry-hud:handoff
```

Portable:

```text
/agy-retry-hud:handoff portable
```

Hoặc deterministic CLI:

```bash
agy-retryctl handoff create
agy-retryctl handoff create --portable
```

Để đưa selected untracked work-in-progress vào bundle, phải chỉ định tường minh từng file:

```bash
agy-retryctl handoff create --portable \
  --include-untracked notes.txt \
  --include-untracked src/new-file.js
```

Plugin không tự pack toàn bộ untracked files. `.env`, key/credential paths, binary untracked files và text có secret patterns bị chặn.

## Portable `.agyh`

Local handoff nằm dưới:

```text
.agy-retry/handoffs/<handoff-id>/
```

Portable artifact:

```text
<project>-<handoff-id>.agyh
```

Bundle v1 chứa `manifest.json`, `HANDOFF.md`, `CONTINUE.md`, workspace identity, state, Git status/diff, selected WIP, test evidence và checksums.

Handoff chỉ dùng source conversation ID như provenance. Nó **không cần** conversation cũ để continue.

Absolute path source cũng chỉ là metadata. Repo files trong handoff dùng workspace-relative paths và import rebind theo Git identity.

### Chuyển sang máy khác

Máy A:

```bash
agy-retryctl handoff create --portable
```

Copy `.agyh` sang máy B, mở đúng repo tại path bất kỳ, rồi:

```text
/agy-retry-hud:continue-handoff /path/to/task.agyh
```

Hoặc:

```bash
agy-retryctl handoff import /path/to/task.agyh
agy-retryctl handoff validate /path/to/task.agyh
```

`continue-handoff` phải reconcile repo/Git/current files trước khi làm tiếp, không blindly tin checkpoint và không repeat confirmed side effects.

## Skills

Plugin package:

```text
🔁 /agy-retry-hud:retry
📦 /agy-retry-hud:handoff
▶️ /agy-retry-hud:continue-handoff
📋 /agy-retry-hud:handoff-status
ℹ️ /agy-retry-hud:retry-status
```

Không truyền handoff cho `continue-handoff` thì skill chạy `agy-retryctl handoff list --json` và trình bày numbered choices. v0.4 không giả lập native picker API nếu AGY không expose API đó.

## Retry + handoff interaction

Ví dụ context 93%, handoff READY, sau đó hết 5h quota:

```text
WAIT_QUOTA
  ↓ reset
check weekly
  ├─ weekly blocked -> stop, no model send
  └─ weekly healthy
       ├─ rollover armed -> new AGY conversation + continue handoff
       └─ otherwise -> resume exact old conversation
```

Khi context quá cao, worker ưu tiên safe rollover thay vì tiếp tục bơm vào conversation gần đầy.

## Config

Linux/macOS mặc định:

```text
~/.config/agy-retry-hud/config.json
```

Windows:

```text
%APPDATA%\agy-retry-hud\config.json
```

Hoặc `AGY_RETRY_HUD_CONFIG`.

Xem `config.example.json`.

Default policy:

```json
{
  "retry": {
    "enabled": true,
    "stopWhenWeeklyExhausted": true,
    "weeklyRemainingThreshold": 0.01
  },
  "handoff": {
    "enabled": true,
    "snapshotAt": 85,
    "prepareAt": 90,
    "rolloverAt": 95,
    "cancelRolloverBelow": 80,
    "autoCreateNewSession": true,
    "semanticSummary": true,
    "mechanicalFallback": true
  }
}
```

## Security model

- Imported `.agyh` là untrusted input.
- ZIP path traversal bị reject.
- Checksums được verify.
- Unsupported format/version bị reject.
- Secret patterns và sensitive paths bị block khi export/import.
- Prompt không được shell-interpolate.
- Không tự approve permission.
- Không tự switch account để né quota.
- Không copy full transcript vào handoff.

## Doctor

Sau install:

```bash
node ~/.gemini/antigravity-cli/plugins/agy-retry-hud/setup.js doctor
```

Nếu AGY stage shared plugin ở `~/.gemini/config/plugins/`, dùng path đó.

Doctor kiểm tra Node, plugin, status line, five skills, portable schema và `agy-retryctl` launcher. Doctor không tạo model turn.

## Development verification

```bash
npm test
npm run verify:plugin-package
node src/cli.js demo --plain --data-dir .demo-state
node src/retryctl.js --help
npm run verify:live
```

`verify:live` chỉ chạy read-only probes và không cố tiêu quota để tạo lỗi.

Offline suite hiện tại: **104/104 PASS**.

CI matrix đã cấu hình Node 24.21.0 trên Ubuntu/macOS/Windows. Việc CI được cấu hình không được xem là live platform evidence cho tới khi runner thực sự chạy.

## Tài liệu thiết kế

- `spec.md` — approved product/technical spec v0.4.0.
- `plan.md` — implementation plan WS0–WS12 + execution status.
- `docs/V0.4-EXECUTION.md` — execution evidence và external release gates.

## Giới hạn đã chủ động giữ

- Không thay AGY TUI.
- Không giả lập keyboard/PTY để ép TUI switch conversation.
- Không thay thuật toán native context compaction của AGY.
- Không tự retry khi weekly quota bị block.
- Không tự kết luận uncertain tool side effect là thành công/thất bại.
- Không hứa current TUI tự nhảy sang background rollover conversation; new conversation ID được lưu để resume/open lại.

## v0.4.2 HUD and setup skill

The native HUD uses a fixed visual metric grid. Context and quota percentages change color by severity, and 5h/weekly quota share one row when the terminal is wide enough.

Use the new setup skill inside AGY:

```text
/agy-retry-hud:setup
```

Or use the deterministic control plane:

```bash
agy-retryctl setup status --json
agy-retryctl setup repair --json
```

`setup repair` restores missing agy-retry-hud statusline wiring, Stop hook wiring, the `agy-retryctl` launcher and a missing default config. It does not silently overwrite an unrelated custom statusline; use `--force-statusline` only after explicit approval.


## v0.4.4 compact HUD and setup-skill discovery

Compact HUD is enabled by default and normally uses two terminal rows:

```text
╭─ ● READY │ Gemini 3.8 Flash (High) │ Pro │ retry:ON │ handoff:OFF
╰─ ctx █░░░░░░░ 4% 40k/1M │ 5h ████████ 99% ↻ 4h49m │ week █░░░░░░░ 6% ↻ 19h38m
```

To restore the previous detailed layout, set `hud.compact` to `false` in the agy-retry-hud config.

If `/agy-retry-hud:setup` is missing from `/skills`, run the packaged repair once from the shell:

```bash
node <installed-plugin>/setup.js repair
```

The repair reports `installLocation`, `sharedConfigStaged`, `cliStaged`, and `skillsDiscoverable`. Current AGY releases may install global plugins under the shared `~/.gemini/config/plugins/agy-retry-hud` path; some builds/documentation also use `~/.gemini/antigravity-cli/plugins/agy-retry-hud`. v0.4.4 accepts either supported global discovery path and wires the HUD to the path AGY actually installed.

---

## English quick guide — v0.5.0

`agy-retry-hud` keeps the native AGY TUI and adds a statusline, safe retry policy, portable handoff, and a singleton background daemon.

The daemon does **not** require systemd, launchd, or a Windows Service. One daemon manages all AGY conversations for the default user state root.

```bash
# install plugin package
node ./agy-retry-hud/setup.js install --force-statusline

# daemon
agy-retryctl daemon status --json
agy-retryctl daemon restart

# HUD modes
agy-retryctl hud on     # HUD + daemon + retry + handoff
agy-retryctl hud hide   # hide visual HUD, keep runtime active
agy-retryctl hud off    # disable plugin runtime

# health
agy-retryctl doctor --json
```

Recommended source checkout locations:

- Linux: `~/src/agy-retry-hud`
- macOS: `~/Developer/agy-retry-hud`
- Windows: `$HOME\source\repos\agy-retry-hud`

The daemon can wake retry deadlines while the AGY TUI is idle. The public AGY plugin API does not expose a safe background TUI repaint primitive, so the visible statusline may remain unchanged until AGY redraws; scheduler state itself continues independently.
