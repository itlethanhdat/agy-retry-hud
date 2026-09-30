# Antigravity CLI Native HUD + Auto Retry — Research, Design Spec & Implementation Plan

Ngày cập nhật: 30/09/2026. **Revision 3.1 execution update**. Revision này thay thế quyết định UI của Revision 2: HUD native trong `agy` là requirement chính; wrapper headless không còn là UI mặc định.

## 1. Mục tiêu và phạm vi

Tạo project `agy-retry-hud` cho Antigravity CLI chính thức (`agy`) trên Linux, macOS, Windows với hai năng lực bắt buộc:

1. **HUD tích hợp trực tiếp vào TUI native của `agy`**, theo cùng họ cơ chế với `franksde/agy-hud`: dùng native status line, không dựng TUI thay thế.
2. **Auto Retry** khi gặp quota 5h/individual hoặc lỗi API tạm thời: chờ đúng deadline/backoff, không spam message, resume đúng conversation và không tự approve quyền.

Message mặc định vẫn là `DEFAULT_RESUME_MESSAGE` tại mục 4.7 và có thể override ở wrapper/future native config.

Không gửi model message để probe quota. Không giả lập bàn phím/PTY để điều khiển TUI. Không đổi account/model để né quota.

### Definition of Done

Code/offline DoD:

- Native status line render được từ payload JSON của AGY.
- Plugin Stop hook nhận incident và trả về nhanh; không sleep dài trong hook.
- Background worker lưu deadline qua state, dedupe incident, resume exact conversation qua headless stream.
- Manual continuation/native activity thắng scheduler để không gửi trùng.
- Existing wrapper/policy/quota/state/adapter tests vẫn pass.
- Installer/doctor/uninstaller native có test.
- Full offline suite pass và release archive/checksum được tạo.

Live release DoD:

- Smoke thật với authenticated `agy` và fixture đã redacted.
- Verify native status line + plugin Stop hook + exact-conversation resume trên Linux/macOS/Windows.
- Natural quota/API recovery được quan sát khi có cơ hội; không cố tình đốt quota.

Nếu live DoD chưa đủ, release phải ghi **pre-release**, không tuyên bố stable.

## 2. Kết quả khảo sát và sửa quyết định Revision 2

### 2.1 Vì sao plan cũ thiếu native HUD

Revision 2 đã chốt wrapper làm process owner và ghi rõ:

- wrapper không attach vào TUI;
- MVP có HUD + input riêng;
- Stop hook/scheduler và PTY để sau MVP.

Điều này tối ưu cho việc kiểm soát retry nhưng không đáp ứng requirement mới/đúng hơn: “dùng `agy` như bình thường và HUD xuất hiện ngay trong TUI”. Vì vậy phần thiếu không phải bug implementation đơn lẻ mà là **nợ kiến trúc trong plan**.

### 2.2 Cơ chế native được xác minh từ tài liệu hiện tại

Nguồn chính thức:

- Status line customization: https://antigravity.google/docs/cli/statusline
  - TUI chạy custom command khi state thay đổi.
  - AGY pipe JSON state vào stdin và render stdout trong status line dưới prompt.
  - Payload có `conversation_id`, workspace/cwd, model, context, quota, agent state, pending input/tool confirmation và terminal width.
- `/statusline`: https://www.antigravity.google/docs/cli-statusline
  - Có thể wire custom status line ngay từ TUI.
- Hooks: https://www.antigravity.google/docs/hooks
  - Plugin-level `hooks.json` được hỗ trợ.
  - Stop hook nhận `terminationReason`, `error`, `fullyIdle`, `conversationId`, `workspacePaths`, `modelName`.
  - Hook command timeout mặc định 30 giây, vì vậy **không được dùng hook để ngủ 5 giờ**.
- Plugins: https://www.antigravity.google/docs/plugins và https://www.antigravity.google/docs/cli/plugins/
  - `plugin.json` + optional `hooks.json` là layout hợp lệ.
  - Plugin global/manual và `agy plugin install` đều là cơ chế native.
- Headless stream: https://www.antigravity.google/docs/cli/headless/
  - Exact conversation resume qua `--conversation` và JSON stream là cơ chế worker dùng để gửi continuation sau deadline.

Repo tham khảo:

- https://github.com/franksde/agy-hud
  - Dùng native `/statusline`; archive có `plugin.json`, `hooks/`, `dist/`.
  - Không cần thay TUI bằng wrapper.
  - Windows chưa được repo mẫu verify; project này vẫn phải tự test Windows thay vì kế thừa claim.
- https://github.com/rupok/antigravity-auto-retry
  - Chỉ tham khảo ý tưởng debounce/circuit breaker của IDE Retry button; không tái sử dụng DOM automation cho CLI.

## 3. Kiến trúc Revision 3

### 3.1 Quyết định

| Thành phần | Vai trò | Quyết định |
|---|---|---|
| Native AGY TUI | Prompt, output, permissions, slash commands | **Giữ nguyên** |
| Native `/statusline` | HUD model/context/quota/retry | **UI mặc định** |
| Plugin Stop hook | Thu incident + conversation/workspace identity | **Bắt buộc** |
| Persistent local state | Deadline/counters/fingerprint/telemetry | **Bắt buộc** |
| Detached retry worker | Chờ deadline và resume exact session | **Bắt buộc** |
| Headless stream adapter | Một retry turn trong exact conversation | **Worker runtime** |
| Wrapper HUD cũ | Demo/fallback/diagnostic | Giữ, không phải primary UX |
| PTY/ConPTY/keystroke | Inject input vào TUI | **Không dùng** |

### 3.2 Data flow

```text
normal agy TUI
  ├─ status change → statusLine command → native-entry statusline
  │                                  ├─ render HUD to stdout
  │                                  └─ cache sanitized telemetry locally
  │
  └─ execution terminates → plugin Stop hook → native-entry stop-hook
                                      ├─ classify terminal incident
                                      ├─ merge current quota telemetry
                                      ├─ persist WAIT_* deadline
                                      ├─ dedupe fingerprint
                                      ├─ spawn detached worker
                                      └─ return {decision:"stop"} immediately

worker
  ├─ acquire conversation lock
  ├─ wait in cancelable <=30s chunks
  ├─ re-read native telemetry/state
  ├─ cancel if TUI became active / pending input / permission
  ├─ spawn agy stream-json --conversation <exact ID>
  ├─ require matching init + matching workspace
  ├─ send DEFAULT_RESUME_MESSAGE exactly once
  ├─ terminal success → SUCCEEDED
  └─ retryable terminal failure → bounded next deadline
```

### 3.3 Race invariants

1. Status-line redraw never dispatches retry and never calls model API.
2. Stop hook never waits for quota reset/backoff.
3. One worker lease per conversation.
4. Duplicate Stop incident with same fingerprint/deadline does not spawn a second worker.
5. Normal native Stop sets state back to IDLE and cancels any pending retry; this covers manual continuation.
6. Before dispatch, worker re-checks latest native telemetry. Native activity, pending input or tool confirmation cancels/blocks background dispatch.
7. Worker cannot dispatch before AGY emits matching `init` for requested conversation.
8. Workspace mismatch or uncertain outcome => PAUSED_UNCERTAIN.
9. Nested Stop hook created by worker process is ignored using `AGY_RETRY_NATIVE_WORKER=1`, avoiding recursive scheduling.

## 4. Design spec

### 4.1 Stack

Implementation hiện tại dùng Node.js 24 ESM standard library. Revision 2 ban đầu đề xuất Go, nhưng execution đã chuyển Node vì môi trường lúc triển khai không có Go compiler/download. Revision 3 không đảo stack giữa chừng; native plugin cũng dùng cùng runtime để chia sẻ policy/state/adapter.

Runtime modules chính:

- `src/native.js`: native state/statusline/hook/worker.
- `src/native-entry.js`: process entry cho `statusline`, `stop-hook`, `worker`, `status`, `cancel`.
- `src/adapter.js`: AGY stream child.
- `src/policy.js`: classification/deadline/budget.
- `src/state.js`: atomic JSON + lease.
- `src/session.js`: default continuation + identity guards.
- `plugin/agy-retry-hud/`: staged native plugin bundle.
- `scripts/install-native.js`: install/doctor/uninstall.

### 4.2 Native plugin packaging

Plugin bundle:

```text
plugin/agy-retry-hud/
├── plugin.json
├── hooks.json
├── hooks/
│   ├── status-line.sh
│   └── status-line.ps1
├── dist/
│   └── bundled project JS modules
├── README.md
└── LICENSE
```

Installer stages plugin under user-global Antigravity plugin location and rewrites `hooks.json` Stop command to an absolute runtime path. Đây là chủ ý cross-platform: plugin hook không phụ thuộc current workspace/cwd.

Installer chỉ ghi `statusLine`; giữ nguyên các setting khác. Nếu status line khác đang tồn tại, mặc định refuse; `--force-statusline` mới thay và receipt lưu cấu hình cũ để uninstall khôi phục.

### 4.3 Native HUD

HUD tối đa hai dòng compact:

- line 1: model, context %, quota 5h/daily/weekly và countdown reset;
- line 2: retry status/countdown/attempt, agent state, workspace.

Rules:

- sanitize terminal control/bidi characters;
- clip theo terminal width;
- missing data => `?`, không dựng số;
- không yêu cầu Nerd Font;
- statusline invocation chỉ local I/O;
- telemetry state tách khỏi retry state để redraw không ghi đè scheduler state;
- telemetry unchanged được throttle ghi đĩa.

### 4.4 Stop-hook classification

Chỉ dùng `payload.error` của Stop hook + structured quota telemetry. Không scan arbitrary model/tool output.

| Class | Policy |
|---|---|
| quota individual có reset | wait reset + margin + jitter |
| quota individual thiếu reset | fallback 5h |
| weekly/daily có reset | wait nếu nằm trong total budget |
| weekly/daily thiếu reset | NEEDS_USER |
| 502/503/504/transport | exponential backoff |
| 429 có retry hint | backoff/server delay |
| auth/billing/credit/permanent | NEEDS_USER |
| unknown/nested unsupported | NEEDS_USER |
| fullyIdle=false | PAUSED_UNCERTAIN |

### 4.5 Anti-spam defaults

- quota fallback: 5h;
- reset margin: 90s;
- jitter: 0–30s;
- transient: 60s exponential, cap 15m;
- max transient retries: 6;
- max quota retries: 2;
- max incident elapsed: 24h;
- watchdog one headless turn: 60m.

Server minimum delay is never shortened.

### 4.6 Persistent state

Native state stored outside workspace in per-user state directory; conversation ID is hashed into filename. Store includes:

- schemaVersion;
- conversationId;
- cwd/model;
- status/reason/retryKind;
- startedAt/updatedAt/nextRetryAt;
- error fingerprint;
- retry counters;
- config snapshot;
- continuation message;
- sanitized statusline telemetry snapshot.

Telemetry is stored separately from retry state to prevent frequent TUI redraw from reverting scheduler state.

### 4.7 Default continuation message

Constant exact text:

```text
Continue the existing task in this same conversation from the last confirmed checkpoint. Preserve the agreed requirements, decisions, constraints, and approved plan. Review the available conversation history, progress notes, and current workspace state to identify completed work and the next unfinished step. Verify the outcome of any interrupted operation before retrying it; do not repeat completed work or duplicate side effects. Continue within the existing scope and permissions. If essential context is missing or an operation's outcome is uncertain, pause and ask for clarification instead of guessing or restarting the task.
```

Message không thay thế conversation history và không bảo đảm exactly-once cho external side effects.

### 4.8 Security

- spawn argv, không shell interpolation cho AGY adapter;
- không đọc credential/token;
- không auto-approve permissions;
- không log raw transcript/stderr theo mặc định;
- native statusline/hook state chỉ lưu metadata cần thiết;
- workspace identity được realpath-validate trước background send;
- nested worker hook không schedule recursively;
- installer không sửa permission/profile/account settings.

## 5. Acceptance criteria Revision 3

### 5.1 Offline/code acceptance

1. Statusline JSON → 2-line HUD không crash khi optional fields thiếu.
2. Redraw không tăng model/quota calls.
3. Quota 5h=0 có reset T → deadline T+margin+jitter.
4. 503 → backoff và một worker.
5. Duplicate Stop → không thêm worker.
6. Auth/unknown/fullyIdle=false → không worker.
7. Normal native Stop trong lúc WAIT → IDLE, pending worker tự thoát.
8. Native agent active trước deadline → worker CANCELED trước spawn AGY.
9. Worker resume exact conversation; mismatch conversation/cwd => không gửi.
10. Worker send continuation một lần sau matching init.
11. Retry budget sống qua state và dừng EXHAUSTED đúng policy.
12. Installer giữ unrelated settings, refuse foreign statusLine nếu không force, uninstall restore previous statusLine.
13. Plugin dist entry chạy từ stdin payload độc lập với source tree.
14. Full existing 0.1.x wrapper regression suite vẫn pass.

### 5.2 Live acceptance còn bắt buộc trước stable

1. `agy plugin`/manual global plugin được CLI thật load; `/hooks` thấy Stop hook.
2. Native status line hiển thị trong `agy` thật và nhận schema như docs.
3. Harmless Stop success không schedule.
4. Harmless synthetic/repro transient nếu có cách an toàn → worker exact-conversation resume.
5. Permission request không bị background worker vượt qua.
6. Linux/macOS/Windows path, Unicode workspace, process detach/cleanup.
7. Sleep/wake/restart behavior.
8. Natural quota incident/recovery khi xuất hiện; không cố tình consume quota.

## 6. Implementation plan và trạng thái

> Execution rule: implementation phải theo dependency order; không đánh dấu live gate pass từ fake child.

### WS0 — Contract/evidence

- [x] Research official status line, Stop hook, plugin layout, headless exact-conversation behavior.
- [x] Xác định hook timeout khiến long wait phải ra worker ngoài hook.
- [x] Ghi version floor hiện tại cho headless stream: 1.1.15; recommended 1.2.13+ theo compatibility evidence hiện có.
- [ ] Thu redacted authenticated `agy --version`, `--help`, live statusline payload, Stop payload và real stream fixtures.
- [ ] Verify provider/version-specific AGY_ERROR/quota schemas.

**Status:** code contract đủ để implement bảo thủ; live evidence còn external gate.

### WS1 — Stream adapter/parser

- [x] NDJSON decoder UTF-8/CRLF/size guard.
- [x] Spawn không shell, drain stdout/stderr, init/watchdog.
- [x] Exact conversation arg + matching init invariant.
- [x] Synthetic subprocess tests.
- [ ] Live fixture conformance against authenticated AGY.

### WS2 — Classifier/policy

- [x] Quota/transient/permanent/unknown classification.
- [x] Reset + margin/jitter, fallback 5h, exponential backoff, budgets.
- [x] Unknown/nested schemas conservative stop.
- [x] Table/regression tests.

### WS3 — State/lock/scheduler

- [x] Atomic JSON state.
- [x] Exclusive lease + explicit dead-lock recovery.
- [x] Cancelable bounded wait; no 5h sleeps in tests/hook.
- [x] Persistent counters/deadline.

### WS4 — Headless supervisor/fallback wrapper

- [x] Same-conversation retry flow.
- [x] Native/internal retry overlap guards in wrapper core.
- [x] Partial/uncertain result handling.
- [x] Synthetic integration demo.

### WS5 — Config/release platform gates

- [x] Config validation/precedence and default message regression.
- [x] Full local offline suite.
- [x] CI matrix configured Ubuntu/macOS/Windows Node 24.21.0.
- [x] Release docs/checksum workflow prepared.
- [ ] Execute CI matrix on hosted runners.
- [ ] Authenticated live smoke on Linux/macOS/Windows.

### WS6 — QuotaProvider

- [x] Scoped cache/freshness/single-flight/timeout.
- [x] 5h + weekly blocking-reset decision tests.
- [x] No redraw-triggered refresh.
- [ ] `/usage` live schema smoke for target AGY/provider/account.

### WS7 — Wrapper HUD/session continuity

- [x] Existing standalone wrapper HUD/input retained as fallback.
- [x] Unicode/paste/control-character sanitization tests.
- [x] Session ID/cwd/checkpoint continuity guards.
- [x] Wrapper does not auto-approve permissions.

### WS8 — **Native AGY integration** (new mandatory workstream)

Files: `src/native.js`, `src/native-entry.js`, `plugin/agy-retry-hud/*`, `scripts/install-native.js`, native tests.

- [x] Parse official statusline payload and render HUD inside native TUI.
- [x] Cache sanitized conversation/model/context/quota/agent telemetry.
- [x] Add root `plugin.json` and plugin-level `hooks.json`.
- [x] Add Stop hook classifier/scheduler; return immediately, never long-sleep.
- [x] Add detached worker with per-conversation lock.
- [x] Exact-conversation stream resume + matching workspace/init validation.
- [x] Deduplicate repeated Stop events.
- [x] Normal native Stop cancels pending retry after manual continuation.
- [x] Re-check native telemetry before dispatch and cancel if TUI became active/pending input/tool confirmation.
- [x] Prevent recursive worker Stop-hook scheduling.
- [x] Native installer/doctor/uninstaller with previous-statusLine restore.
- [x] Release plugin `hooks.json` self-resolves installed runtime; direct `agy plugin install` no longer depends on installer placeholder rewriting.
- [x] Safe live-verification helper probes version/plugin/hooks/usage without a model turn.
- [x] Packaged dist entry subprocess test.
- [x] Offline native tests green.
- [ ] Live plugin load + `/hooks` + statusline smoke on authenticated Linux.
- [ ] Live same tests macOS.
- [ ] Live same tests Windows.

### WS9 — Final release validation

- [x] Update README/CHANGELOG/compatibility/plan to Revision 3 architecture.
- [x] Mark wrapper as fallback, native TUI as default UX.
- [x] Re-run syntax checks and full offline suite after native integration.
- [x] Build full project archive + native plugin archive + SHA-256.
- [ ] Remove pre-release label only after all live gates above pass.

## 7. Execution order Revision 3

Completed dependency order for code/offline work:

`WS0 research → WS1 → WS2 → WS3 → WS6 → WS4 → WS7 → WS8 → WS5 offline → WS9 offline`

Remaining external verification order:

`Linux authenticated native smoke → macOS CI/live → Windows CI/live → natural quota capture/recovery → stable release decision`

Revision 3.1 also closed a packaging gap discovered during execution: direct native plugin installation now has a self-resolving Stop hook command, and a read-only live verifier is included. No further code work is known unless live smoke exposes a protocol/platform incompatibility.

## 8. Handoff / known limitations

- Native HUD is now a first-class requirement and implemented path, fixing the main omission of Revision 2.
- Wrapper remains available, but users should normally launch `agy` itself after installing the plugin.
- Background worker resumes the same conversation headlessly. Do not assume an already-open TUI instantly paints the background turn; conversation state is authoritative and a resume/reopen may be needed to view the result depending on AGY behavior.
- Current package remains pre-release because this environment has no authenticated AGY binary/account and no executed macOS/Windows runner. Those are evidence debts, not hidden “completed” tasks.
- Any unexpected live schema results in conservative pause rather than guessed retry.
