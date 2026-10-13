# agybox

Multi-account AGY (Antigravity CLI) sandbox manager.

- **1 Docker container = 1 AGY account.** Mỗi account có HOME riêng
  (`~/.agy-sandbox/accounts/<name>`), token OAuth cô lập hoàn toàn.
- **Workspace share chung:** bind-mount vào mọi container (`~/workspace → /workspace`
  mặc định, chỉnh được trên web UI).
- **Auto-rotate (phase sau):** hết quota → tự chuyển account, resume session;
  tất cả hết quota → về account reset gần nhất và chờ tự continue.
- **agy hub:** web UI local (`agybox hub`) quản lý account, xem quota/reset,
  setup single-click.

## Trạng thái hiện tại: P0 + H0 + P1 + P2

- [x] Account registry (`add`/`remove`/`list`), home dir riêng chmod 700
- [x] `agybox status`: bảng quota 5h/weekly + countdown reset
- [x] Workspace mappings: validate + sinh `-v` args cho docker
- [x] `agybox hub`: server local 127.0.0.1:8765, token auth, SSE realtime
- [x] Dashboard web chỉ đọc: cards account, quota bars, countdown, mappings
- [x] P1: `agybox run` supervised session + auto-rotate khi hết quota (verify `/usage`, handoff, resume/fallback, guards, locks)
- [ ] P2: WAITING_RESET — hết tất cả thì về account reset gần nhất và chờ tự continue (xem DESIGN-rotation.md §6–§7)
- [ ] H1: actions trên web (rotate, login wizard, session)
- [ ] H2: Setup Center single-click

## Cài đặt

```bash
cd ~/workspace/agybox
# dùng trực tiếp, chưa cần npm install (không có dependency)
./bin/agybox status
./bin/agybox hub --open
```

## Lệnh

```
agybox status                  bảng quota/reset mọi account
agybox list                    liệt kê account
agybox add <name> [email]      đăng ký account mới
agybox remove <name>           xóa account
agybox workspaces              xem folder mappings
agybox run [--account NAME]    mở supervised session (tự rotate khi hết quota)
agybox rotate [NAME]           đặt preferred account cho lần run kế tiếp
agybox cancel-wait             dừng supervisor đang chờ reset quota
agybox hub [--port N] [--open] mở web UI
```

## P2: WAITING_RESET — chờ reset gần nhất rồi tự continue

Khi **tất cả** account đều hết quota, `agybox run` không thoát nữa mà:

1. **PICK_NEAREST_RESET**: đo quota tất cả account, chọn account có reset
   gần nhất (bucket 5h trước, rồi weekly). Không đo được reset → đo lại
   tối đa 3 lần rồi bỏ cuộc có thông báo.
2. **WAITING_RESET**: giữ lock của account đó (lệnh `run` khác cho cùng
   account bị từ chối), ghi `~/.agy-sandbox/supervisor-state.json`
   (`phase: waiting`), sleep đến `resetAt + resetBufferSec` (mặc định 90s).
   Hiển thị countdown `⏳` mỗi 30s. `agybox cancel-wait` để dừng chờ.
3. **VERIFY_QUOTA → RESPAWN**: dậy thì **đo lại quota** (không tin timer —
   máy có thể đã sleep/hibernate), có quota thì `agy --resume` tiếp tục
   session; vẫn hết thì tính lại reset gần nhất, tối đa 5 vòng.

Lưu ý:

- Supervisor luôn đo quota **tươi** (`force: true`, bỏ qua cache 60s) ở các
  điểm quyết định: sau signal và sau khi dậy — cache cũ từng làm supervisor
  "không thấy" reset vừa xảy ra (bắt được bởi e2e).
- Máy sleep qua giờ hẹn: sau wake vẫn verify lại trước khi resume.
- Hủy chờ giữa chừng: `agybox cancel-wait` (flag được supervisor nhận và
  xóa), hoặc Ctrl-C.

## P1: supervised session + auto-rotate

`agybox run` mở `agy` trong container của account (qua `docker exec`) dưới
sự giám sát của supervisor:

- Supervisor đọc output, bắt signal hết quota (429, `RESOURCE_EXHAUSTED`,
  "quota exceeded"...), **verify lại bằng `/usage`** rồi mới rotate —
  signal thoáng qua không gây rotate oan.
- Rotate = snapshot handoff (`~/.agy-sandbox/handoffs/`) → dừng graceful
  (`/exit` → 5s → SIGTERM) → `docker exec` sang container account kế tiếp
  với `agy --resume <sessionId>`; nếu resume fail thì mở session mới và
  inject tóm tắt handoff.
- Hết quota tất cả account → **P2 WAITING_RESET**: tự về account có reset
  gần nhất, chờ đến giờ reset rồi tự continue (xem dưới).
- Guards: tối đa 8 rotations/session, cooldown 30s, account flapping bị
  bỏ qua 15 phút, lock file per-account chống 2 supervisor cùng lúc.

Giới hạn P1: supervisor dùng pipe (không có pty thật vì zero-dependency) —
dùng `docker exec -it` khi stdin/stdout là TTY, fallback `-i` khi không;
một số TUI vẫn có thể cần pty thật — sẽ cải thiện ở phase sau.

## Yêu cầu

- Node.js ≥ 18. Không có dependency ngoài.
- Docker (để chạy container account). Khi chưa có Docker, `status`/API vẫn
  chạy nhưng báo `docker-unavailable` — registry và web UI dùng được bình thường.
- Trong container: `GEMINI_FORCE_FILE_STORAGE=true` để token lưu ra file.

## Tài liệu thiết kế

- `DESIGN-rotation.md` — auto-rotate option 3 + wait-for-nearest-reset
- `DESIGN-hub.md` — web UI agy hub (đã bổ sung workspace mapping §4b)
