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

## Trạng thái hiện tại: P0 + H0

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
agybox hub [--port N] [--open] mở web UI
```

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
- Hết quota tất cả account → báo và dừng (P1). **P2** sẽ thêm WAITING_RESET:
  tự về account reset gần nhất và chờ continue.
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
