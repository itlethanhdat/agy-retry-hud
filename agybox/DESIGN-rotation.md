# agybox auto-rotate — Detailed Design (Option 3 + wait-for-nearest-reset)

Ngày: 2026-10-13. Tác giả: Muse (đề xuất cho Đạt).
Bối cảnh: `agybox` = 1 Docker container / 1 tài khoản AGY, HOME riêng từng
container (`accounts/<name>` → `/home/agent`), workspace bind-mount chung,
`conversations/` share chung, chỉ file token riêng từng account.

## 1. Mục tiêu

- Đang code trong session TUI `agy`, account hết quota → **tự động** chuyển
  sang account còn quota, resume đúng session đang làm dở.
- Khi **tất cả** account đều hết quota → tự chuyển về account có **reset gần
  nhất**, chờ đến giờ reset rồi tự continue (không cần user canh).
- User luôn biết đang ở account nào, vì sao rotate, bao giờ resume.

## 2. Kiến trúc

```
┌─ agybox run ──────────────────────────────┐
│ supervisor (host process, owns user tty)  │
│   ├─ account registry + rotation policy   │
│   ├─ quota state cache (per account)      │
│   ├─ pty output watcher (quota signals)   │
│   ├─ handoff snapshotter                  │
│   └─ reset scheduler (wake timer)          │
│         │ docker exec -it                 │
│   ┌─────▼──────┐   ┌──────────┐   ┌──────────┐
│   │ agy (acc1) │   │ agy acc2 │   │ agy acc3 │
│   │ container  │   │ container│   │ container│
│   └────────────┘   └──────────┘   └──────────┘
│   shared volumes: /workspace, conversations/ (chung)
│   private per container: .gemini/.../antigravity-oauth-token
└───────────────────────────────────────────┘
```

- Supervisor là 1 tiến trình trên host, giữ tty của user. Nó spawn
  `docker exec -it <container> agy` làm child và đọc pty output để bắt signal.
- Rotate = kill exec hiện tại → `docker exec -it` sang container của account
  mới với `agy --resume <sessionId>`.
- Không cần Docker network phức tạp; mỗi container chạy `sleep infinity` nền.

## 3. Account registry & quota state

`~/.agy-sandbox/accounts.json`:

```json
{
  "accounts": [
    {"name": "acc1", "email": "a@gmail.com", "container": "agy-acc1",
     "priority": 1, "enabled": true},
    {"name": "acc2", "email": "b@gmail.com", "container": "agy-acc2",
     "priority": 2, "enabled": true}
  ],
  "rotation": {
    "order": ["acc1", "acc2"],
    "maxRotationsPerSession": 8,
    "rotationCooldownSec": 30,
    "verifyTimeoutSec": 20,
    "resetBufferSec": 90,
    "waitRecheckSec": 300
  }
}
```

`~/.agy-sandbox/quota-state.json` (cache, supervisor tự refresh):

```json
{
  "acc1": {
    "checkedAt": 1790900000000,
    "exhausted": true,
    "buckets": [
      {"window": "5h", "remainingFraction": 0, "resetAt": 1790910000000},
      {"window": "weekly", "remainingFraction": 0.62, "resetAt": 1791400000000}
    ],
    "nearestResetAt": 1790910000000
  }
}
```

- Nguồn truth: `docker exec <container> agy -p "/usage" --output-format json`
  chạy với HOME của account đó, parse theo cùng logic `quotaFromStatus`
  của agy-retry-hud (đã có sẵn pattern parse bucket 5h/weekly/daily + reset).
- Refresh khi: trước mỗi lần chọn account rotate, sau khi wake từ WAITING_RESET,
  và định kỳ mỗi 10 phút khi đang ACTIVE (để `agybox status` luôn tươi).

## 4. Phát hiện hết quota (signal detection)

Supervisor đọc pty output của session `agy`, match các pattern (case-insensitive):

- `429`, `RESOURCE_EXHAUSTED`
- `quota.{0,30}exceeded`, `rate.?limit`, `too many requests`
- `monthly limit`, `weekly limit`, `daily limit` + `reached|exceeded`
- `upgrade.*to continue`, `quota will reset`

Quy trình xác nhận (chống false positive):

1. Pattern match → state `VERIFYING`, đánh dấu thời điểm.
2. Chạy `/usage` JSON trong container của account hiện tại (timeout 20s).
3. Nếu bucket liên quan `remainingFraction == 0` → confirmed quota-hit.
   Nếu parse thất bại hoặc còn quota → bỏ qua signal, log warning, tiếp tục
   session (tránh rotate oan vì 1 câu 429 thoáng qua).
4. Debounce: cùng 1 account không rotate quá 1 lần / 30s.

## 5. Handoff & resume

Ưu tiên 1 — **native resume**: vì `conversations/` là volume share chung mọi
container, `agy --resume <sessionId>` trong container acc2 sẽ thấy session file
của acc1. Cần verify thực tế agy có ràng session với account identity không
(xem §10).

Ưu tiên 2 — **handoff bundle** (fallback, và cũng là audit trail):
`~/.agy-sandbox/handoffs/<sessionId>-<ts>.json`:

```json
{
  "sessionId": "abc123",
  "fromAccount": "acc1",
  "cwd": "/workspace/myproj",
  "gitHead": "9f3c2e1",
  "gitDirty": ["src/a.ts"],
  "summary": "Đang refactor auth middleware, còn dở bước 2/4...",
  "pendingTodos": ["viết test cho refresh token", "chạy lint"],
  "interruptedTool": "npm run build (đang chạy dở)",
  "createdAt": 1790900000000
}
```

Khi respawn với fallback: mở session mới và inject handoff summary làm message
đầu tiên ("Tiếp tục công việc từ handoff sau, giữ nguyên context...").

`summary` lấy từ: transcript tail (N dòng cuối pty) + `git status` + todo list
nếu parse được. Không cần hoàn hảo — đủ để model tiếp tục.

## 6. Rotation state machine

```
ACTIVE
  │ quota-hit confirmed (account A)
  ▼
VERIFYING ──(không confirm)──▶ ACTIVE (tiếp tục, log)
  │ confirmed
  ▼
SELECT_NEXT: refresh quota-state các account enabled (trừ A nếu vừa hết),
             chọn theo rotation.order, bỏ qua account exhausted/cooldown
  │ tìm được B
  ▼
HANDOFF: snapshot handoff bundle → graceful stop agy (gửi /exit, timeout 5s
         rồi SIGTERM docker exec) → đợi process thoát hẳn
  │
  ▼
RESPAWN(B): docker exec -it <containerB> agy --resume <sid>
            (fallback: session mới + inject handoff)
  │ thành công → ACTIVE (activeAccount=B, rotationsThisSession++)
  │ thất bại → thử account kế tiếp, hết thì ALL_EXHAUSTED

SELECT_NEXT: không còn account nào
  ▼
ALL_EXHAUSTED
  │
  ▼
PICK_NEAREST_RESET: C = account có min(nearestResetAt) (tính trên bucket 5h
                    trước, rồi weekly). Nếu resetAt unknown → đợi
                    waitRecheckSec rồi đo lại, tối đa 3 lần.
  │
  ▼
SWITCH(C): chuyển exec sang container C ngay (để lúc wake không cần switch
           nữa), dừng agy, ghi trạng thái chờ
  │
  ▼
WAITING_RESET: supervisor sleep đến nearestResetAt + resetBufferSec (90s).
               Hiển thị countdown (xem §8). Cho phép user `agybox cancel-wait`
               để thoát chờ.
  │ timer tới giờ
  ▼
VERIFY_QUOTA: chạy /usage trong container C
  │ còn quota → RESPAWN(C) → ACTIVE
  │ vẫn hết → recompute nearestReset (có thể reset bị lùi) → WAITING_RESET
             (backoff, log rõ lý do)
```

**Loop guard toàn cục:**
- `rotationsThisSession >= maxRotationsPerSession (8)` → dừng auto, báo user
  can thiệp tay (tránh rotate vòng tròn khi telemetry sai).
- Account vừa rotate sang mà lập tức quota-hit trong <60s → đánh dấu
  `flapping`, bỏ qua trong 15 phút.

## 7. Scheduler chờ reset (chi tiết)

- Dùng 1 timer duy nhất trong supervisor (không cần cron hệ thống).
- `sleepUntil = nearestResetAt + resetBufferSec*1000 - Date.now()`.
- Nếu `sleepUntil <= 0` → verify ngay.
- Khi máy sleep/hibernate làm timer trôi: sau wake, verify quota trước khi
  respawn thay vì tin timer (phòng reset đã qua từ lâu).
- Trường hợp 2 bucket: ưu tiên bucket nào **unblock công việc** — thường là 5h;
  nếu 5h còn nhưng weekly hết thì session vẫn chạy được cho đến khi chạm
  weekly, lúc đó machine sẽ quay lại ALL_EXHAUSTED với nearestReset của weekly.

## 8. UX: hiển thị & lệnh

- **Statusline/HUD** (tích hợp agy-retry-hud): thêm segment
  `acc:acc2` khi ACTIVE; khi WAITING_RESET: `⏳ acc1 reset 1h23m`.
- **Notify mỗi lần rotate** (1 dòng trong terminal + log file):
  `⟳ acc1 → acc2 — acc1 hết quota 5h (reset 14:30), resume session abc123`.
- Lệnh:
  - `agybox run [--account acc1]` — mở session có supervisor
  - `agybox rotate [acc2]` — rotate tay
  - `agybox status` — bảng quota/reset từng account + account đang active
  - `agybox cancel-wait` — thoát WAITING_RESET
  - `agybox logs --follow` — xem log supervisor

## 9. An toàn & edge cases

- **Token refresh race:** đợi exec cũ thoát hẳn (check `docker exec` PID gone)
  trước khi spawn mới. Token mỗi account riêng file nên không tranh nhau,
  nhưng 2 agy cùng account vẫn cấm (lock file per account).
- **Không phải quota mà là lỗi khác** (token expired, mạng): pattern không
  match → không rotate; nếu `/usage` báo 401/auth error → dừng và yêu cầu
  `agybox login <acc>` lại, không rotate vòng.
- **User chạy agy ngoài supervisor:** không được giám sát — ghi rõ trong doc,
  `agybox run` là entrypoint duy nhất có auto-rotate.
- **Tool đang chạy dở khi rotate:** ghi `interruptedTool` vào handoff; sau
  resume, model tự quyết định chạy lại. Không cố kill -9 giữa chừng gây dở
  dang file (gửi /exit graceful trước).
- **Bảo mật:** `accounts/` chmod 700, token 600; handoff có thể chứa nội dung
  code — không commit, chỉ lưu local.

## 10. Cần verify thực tế (chưa chắc chắn)

1. `agy --resume <sid>` có chạy được khi session tạo bởi account khác không
   (có ràng identity trong session file không)?
2. Chuỗi lỗi quota chính xác agy in ra là gì (để chốt regex §4)?
3. `agy -p "/usage" --output-format json` trong container headless có trả đủ
   bucket + resetAt không?
4. Hành vi khi weekly hết nhưng 5h còn — agy block luôn hay chỉ warn?

## 11. Phân phase triển khai

- **P0:** registry + `agybox status` (bảng quota/reset) + `agybox rotate` tay.
  Không supervisor, không auto.
- **P1:** supervisor + signal detection + auto-rotate (SELECT_NEXT →
  HANDOFF → RESPAWN). Chưa có WAITING_RESET (hết tất cả thì báo user).
- **P2:** WAITING_RESET scheduler + countdown HUD + `cancel-wait`.
- **P3:** tích hợp sâu agy-retry-hud: reuse `quotaFromStatus`, retry scheduler
  hiện có; thêm `retry.policy: wait | rotate` vào config.
