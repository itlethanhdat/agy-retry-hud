# agy hub — Web quản lý (Design bổ sung)

Ngày: 2026-10-13. Bổ sung cho `agybox` theo yêu cầu của Đạt.
Doc liên quan: `DESIGN-rotation.md` (auto-rotate supervisor).

## 1. Ý tưởng

`agybox hub` — 1 lệnh mở web UI quản lý toàn bộ hệ thống multi-account:
nhìn quota/reset mọi account, single-click setup, chạy lệnh local khi cần,
theo dõi supervisor realtime. Chạy **local-first**: server Node chạy trên
chính máy có Docker, UI mở ở `http://127.0.0.1:8765`.

```
browser ──HTTP/SSE──▶ agybox hub (node, localhost:8765)
                        ├─ serve SPA (1 file index.html, không build step)
                        ├─ REST API + SSE events
                        └─ gọi trực tiếp shared modules (không shell ra CLI)
                             ├─ docker (child_process)
                             ├─ quota parser (reuse pattern agy-retry-hud)
                             └─ supervisor control (rotation state machine)
```

Nguyên tắc: **web và CLI dùng chung code**, không phải 2 implementation.
CLI vẫn đầy đủ; web là lớp mỏng phía trên.

## 2. API (v1)

| Method | Endpoint | Mô tả |
|---|---|---|
| GET | /api/accounts | list account + quota 5h/weekly + resetAt + container state + active badge |
| POST | /api/accounts | tạo account `{name, email}` → trả task id (async) |
| DELETE | /api/accounts/:name | xóa account (xác nhận 2 bước, không xóa token nếu đang active) |
| POST | /api/accounts/:name/login | bắt đầu OAuth → trả `{url, deviceCode?}` |
| POST | /api/accounts/:name/login/code | nhập code/paste token hoàn tất login |
| POST | /api/rotate | rotate tay `{to?}` |
| POST | /api/session/start | mở supervised session (`agybox run` headless + attach log) |
| POST | /api/session/stop | dừng session |
| POST | /api/wait/cancel | thoát WAITING_RESET |
| GET | /api/handoffs | list handoff bundles |
| GET | /api/config | rotation policy hiện tại |
| PUT | /api/config | sửa policy (order, maxRotations, cooldown...) |
| POST | /api/setup/:step | chạy 1 bước setup (docker-check, build-image, install-plugin, autostart) |
| GET | /api/tasks/:id | tiến độ task async |
| GET | /api/events | **SSE**: quota tick, state machine transitions, log lines, task progress |

Mọi thao tác dài (build image, login, install plugin) chạy dạng **task async**,
UI hiện progress bar qua SSE, không block.

## 3. Các màn hình (SPA, hash routing, vanilla JS 1 file)

1. **Dashboard** — cards từng account: quota bar 5h/weekly, countdown reset,
   chấm trạng thái container, badge ACTIVE. Banner toàn cục khi WAITING_RESET
   (`⏳ acc1 reset sau 1h23m — tự continue`). Nút: Rotate now, Start session.
2. **Accounts** — thêm/xóa account, wizard login (hiện OAuth URL + QR để quét
   bằng điện thoại → nhập code), xem token còn hạn không, số conversations,
   handoffs của account.
3. **Session** — trạng thái state machine realtime (ACTIVE/ROTATING/
   WAITING_RESET), log supervisor tail trực tiếp qua SSE, nút Cancel wait.
4. **Setup Center** — checklist single-click:
   - ✓/✗ Docker đã cài → nút cài (chạy script với xác nhận)
   - Build image `agybox` → 1 click
   - Thêm account đầu tiên → mở wizard
   - Cài agy-retry-hud vào tất cả container → 1 click
   - Autostart (systemd unit cho hub + supervisor) → 1 click
5. **Config** — form sửa rotation policy: kéo-thả thứ tự account, max rotations,
   cooldown, reset buffer. Lưu → supervisor reload không cần restart.
   - **Workspace mapping:** danh sách các folder map vào container
     (mặc định `~/workspace → /workspace`). Thêm/sửa/xóa mapping, nút
     "kiểm tra" validate path tồn tại + quyền ghi. Đổi mapping yêu cầu
     recreate container — UI hiện cảnh báo và nút "Áp dụng & recreate"
     single-click. Hỗ trợ mapping riêng từng account (override) ngoài
     mapping chung toàn cục.

## 4b. Data model: workspace mappings

`~/.agy-sandbox/config.json`:

```json
{
  "workspaces": [
    {"name": "main", "hostPath": "~/workspace",
     "containerPath": "/workspace", "mode": "rw", "scope": "global"},
    {"name": "data-ro", "hostPath": "~/data",
     "containerPath": "/data", "mode": "ro", "scope": "global"},
    {"name": "secret-proj", "hostPath": "~/secret",
     "containerPath": "/workspace/secret", "mode": "rw",
     "scope": "account:acc1"}
  ]
}
```

- `scope: global` áp dụng mọi container; `scope: account:<name>` chỉ 1 account.
- `mode: ro` cho folder chỉ cần đọc (data, tài liệu tham khảo).
- Validate: hostPath phải tồn tại và là thư mục; cảnh báo khi map path nhạy cảm
  (`~/.ssh`, `/etc`...); symlink được resolve trước khi mount.
- Áp dụng: render lại compose/docker-run args từ config rồi recreate container
  bị ảnh hưởng. Đổi mapping global → recreate tất cả; đổi mapping per-account
  → chỉ recreate container đó.

## 4. Single-click setup (chi tiết flow "Add account")

```
click "Add account" → nhập tên/email → task chạy:
  1. mkdir accounts/<name>, chmod 700
  2. docker compose up -d (container mới từ image có sẵn)
  3. POST /login → trả OAuth URL → UI hiện URL + QR
  4. user mở URL trên browser/điện thoại, đăng nhập Google
  5. paste code vào UI → POST /login/code → verify bằng /usage
  6. ✓ account sẵn sàng, hiện quota lần đầu
```

Toàn bộ không chạm terminal.

## 5. Bảo mật

- Mặc định bind **127.0.0.1** only.
- Token ngẫu nhiên 32-byte tạo lần đầu, lưu 600 tại
  `~/.agy-sandbox/hub-token`. `agybox hub --open` tự mở browser kèm
  `?token=...` nên user không phải nhập tay.
- `--listen 0.0.0.0` chỉ cho phép khi có `--password` (bcrypt) và in cảnh báo
  rõ ràng. **Không khuyến khích expose trực tiếp ra internet.**
- Muốn quản lý từ điện thoại (ngoài mạng local): dùng **Tailscale** — hub vẫn
  bind localhost, truy cập qua tailnet đã auth sẵn. Ghi guide trong Setup Center.

## 6. Triển khai kỹ thuật

- Node http thuần + SSE (không cần ws dep). Frontend 1 file HTML vanilla JS
  (~800–1000 dòng), không build, chạy offline hoàn toàn.
- Shared modules với CLI: `lib/accounts.js`, `lib/quota.js`, `lib/docker.js`,
  `lib/tasks.js`. CLI `agybox` và hub server cùng require.
- Quota refresh: hub poll 60s/lần khi có client đang xem dashboard (tiết kiệm
  hơn poll liên tục nền).
- Lệnh: `agybox hub [--port 8765] [--open] [--listen 127.0.0.1]`.

## 7. Phase

- **H0** (đi cùng P0): API chỉ đọc + Dashboard + SSE quota. Chưa có action.
- **H1**: actions (rotate, session start/stop, add-account wizard, config).
- **H2**: Setup Center đầy đủ + guide Tailscale cho remote từ điện thoại.