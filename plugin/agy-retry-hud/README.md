# AGY Retry HUD v0.4.5

Native HUD + policy-controlled Auto Retry + Portable Handoff cho **Antigravity CLI (`agy`)**.

`agy-retry-hud` giữ nguyên TUI gốc của AGY. Plugin dùng native status line để hiển thị context/quota/trạng thái, Stop hook để phát hiện lỗi, worker nền để retry có kiểm soát, và `agy-retryctl` + plugin skills để quản lý retry/handoff.

> **Release status:** v0.4.5 implementation complete / offline-verified. Windows status-line command wiring was hardened after a live AGY 1.2.14 quoting failure on native Windows. Target runtime là Node.js 24.x và known target AGY là 1.2.14. Live authenticated AGY, macOS và Windows vẫn là release-evidence gates nếu chưa chạy trên máy tương ứng; project không coi synthetic tests là live verification.

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

Offline suite hiện tại: **80/80 PASS**.

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
