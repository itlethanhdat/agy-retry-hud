# Build and Packaging Guide / Hướng dẫn Build

[English](#english) | [Tiếng Việt](#tiếng-việt)

---

<a id="english"></a>
## English

This document provides instructions for building, packaging, and verifying **AGY Retry HUD** from source.

### 1. Prerequisites

- **Node.js**: `24.x` (target: Node `24.21.0` or `>=24 <25`).
- **npm**: Comes with Node.js.
- **Git**: Installed and accessible in PATH.
- **Antigravity CLI (`agy`)**: Known target `1.2.14` (required for live verification and native plugin installation).
- **Supported Platforms**: Linux, macOS, Windows (PowerShell / cmd).
- **Dependencies**: Zero runtime third-party npm dependencies. All code relies on standard Node.js built-in modules (`node:fs`, `node:path`, `node:url`, `node:crypto`, `node:child_process`, `node:os`).

---

### 2. Repository Structure

```text
agy-retry-hud/
├── src/                      # Core engine and CLI source files
├── plugin/agy-retry-hud/     # AGY Plugin distribution package
│   ├── dist/                 # Built/bundled files (copied from src/)
│   ├── hooks/                # Shell/PowerShell hooks
│   ├── shared/               # JSON schemas (e.g. handoff schema v1)
│   ├── skills/               # Plugin skills for AGY (/skills)
│   ├── plugin.json           # AGY plugin manifest
│   ├── hooks.json            # Plugin hook registrations
│   └── setup.js              # Standalone plugin installer & repair script
├── scripts/
│   ├── build-plugin.js       # Bundles src/ into plugin/agy-retry-hud/dist/
│   ├── verify-plugin-package.js # Validates plugin structure & manifest
│   ├── install-native.js     # Native statusline wiring utility
│   └── live-verify.js        # Read-only live verification probes
├── test/                     # Automated test suites
├── package.json              # Project scripts and engines
└── BUILD.md                  # This file
```

---

### 3. Build Steps

#### Step 1: Clone the repository

```bash
git clone https://github.com/itlethanhdat/agy-retry-hud.git
cd agy-retry-hud
```

#### Step 2: Build the plugin distribution (`dist`)

Run the build script to synchronize and prepare `src/` modules into `plugin/agy-retry-hud/dist/`:

```bash
npm run build:plugin
```

Or execute directly with Node:

```bash
node scripts/build-plugin.js
```

What this script does:
1. Cleans existing `plugin/agy-retry-hud/dist/`.
2. Copies all JavaScript modules from `src/` to `plugin/agy-retry-hud/dist/`.
3. Sets executable permissions (`0o755`) on CLI entry points (`native-entry.js` and `retryctl.js`).
4. Reports total built files (expected: 19 dist files).

#### Step 3: Verify the plugin package

Verify that the staged plugin contains required manifests, valid schemas, and discoverable skills:

```bash
npm run verify:plugin-package
```

Expected output:
```json
{
  "ok": true,
  "pluginRoot": ".../plugin/agy-retry-hud",
  "name": "agy-retry-hud",
  "skills": 6,
  "portableHandoffSchema": 1
}
```

---

### 4. Running Tests

Run the test suite:

```bash
npm test
```

> **Note**: `npm test` automatically executes `npm run build:plugin` before running tests via the `pretest` hook.

Run read-only live checks (when `agy` is authenticated):

```bash
npm run verify:live
```

---

### 5. Packaging Releases

You can package both the **plugin-only archive** (recommended for end users) and the **full repository archive**.

#### A. Plugin-Only Archive (`agy-retry-hud-plugin-v0.4.10.zip`)

On Linux/macOS:
```bash
cd plugin
zip -r ../agy-retry-hud-plugin-v0.4.10.zip agy-retry-hud/
cd ..
```

On Windows (PowerShell):
```powershell
Compress-Archive -Path plugin\agy-retry-hud -DestinationPath agy-retry-hud-plugin-v0.4.10.zip -Force
```

#### B. Full Source Archive (`agy-retry-hud-v0.4.10.zip`)

On Linux/macOS:
```bash
git archive --format=zip --prefix=agy-retry-hud-v0.4.10/ -o agy-retry-hud-v0.4.10.zip HEAD
```

On Windows (PowerShell):
```powershell
git archive --format=zip --prefix=agy-retry-hud-v0.4.10/ -o agy-retry-hud-v0.4.10.zip HEAD
```

---

### 6. Local Installation & Verification

To install the built plugin directly into your local `agy` environment:

```bash
node plugin/agy-retry-hud/setup.js install
```

Verify the installation status:

```bash
agy-retryctl setup status --json
```

Or run the doctor probe:

```bash
node plugin/agy-retry-hud/setup.js doctor
```

---

<a id="tiếng-việt"></a>
## Tiếng Việt

Tài liệu này hướng dẫn cách build, kiểm tra và đóng gói **AGY Retry HUD** từ mã nguồn.

### 1. Yêu cầu môi trường

- **Node.js**: Phiên bản `24.x` (target: Node `24.21.0` hoặc `>=24 <25`).
- **npm**: Đi kèm sẵn với Node.js.
- **Git**: Đã cài đặt và có trong biến môi trường PATH.
- **Antigravity CLI (`agy`)**: Target phiên bản `1.2.14` (cần thiết cho cài đặt plugin và live verification).
- **Hệ điều hành**: Linux, macOS, Windows (PowerShell / cmd).
- **Phụ thuộc**: 0 runtime third-party dependency. Tất cả mã nguồn sử dụng module tiêu chuẩn của Node.js (`node:fs`, `node:path`, `node:url`, `node:crypto`, `node:child_process`, `node:os`).

---

### 2. Các bước Build

#### Bước 1: Clone kho lưu trữ

```bash
git clone https://github.com/itlethanhdat/agy-retry-hud.git
cd agy-retry-hud
```

#### Bước 2: Build thư mục phân phối (`dist`)

Chạy lệnh build để đồng bộ mã nguồn từ `src/` sang `plugin/agy-retry-hud/dist/`:

```bash
npm run build:plugin
```

Hoặc chạy trực tiếp:

```bash
node scripts/build-plugin.js
```

Script sẽ:
1. Dọn dẹp thư mục `plugin/agy-retry-hud/dist/` cũ.
2. Sao chép toàn bộ file `.js` từ `src/` sang `plugin/agy-retry-hud/dist/`.
3. Gán quyền thực thi (`0o755`) cho `native-entry.js` và `retryctl.js`.
4. Báo cáo số lượng file đã build (kỳ vọng: 19 dist files).

#### Bước 3: Xác minh gói plugin

```bash
npm run verify:plugin-package
```

Kỳ vọng:
```json
{
  "ok": true,
  "pluginRoot": ".../plugin/agy-retry-hud",
  "name": "agy-retry-hud",
  "skills": 6,
  "portableHandoffSchema": 1
}
```

---

### 3. Kiểm thử (Testing)

Chạy kiểm thử:

```bash
npm test
```

> **Ghi chú**: Lệnh `npm test` sẽ tự động kích hoạt `npm run build:plugin` trước khi chạy các file test qua hook `pretest`.

---

### 4. Đóng gói bản Release (ZIP)

#### A. Gói Plugin cho người dùng (`agy-retry-hud-plugin-v0.4.10.zip`)

Trên Windows (PowerShell):
```powershell
Compress-Archive -Path plugin\agy-retry-hud -DestinationPath agy-retry-hud-plugin-v0.4.10.zip -Force
```

Trên Linux / macOS:
```bash
cd plugin && zip -r ../agy-retry-hud-plugin-v0.4.10.zip agy-retry-hud/ && cd ..
```

#### B. Gói toàn bộ mã nguồn (`agy-retry-hud-v0.4.10.zip`)

```bash
git archive --format=zip --prefix=agy-retry-hud-v0.4.10/ -o agy-retry-hud-v0.4.10.zip HEAD
```

---

### 5. Cài đặt thử nghiệm tại chỗ

```bash
node plugin/agy-retry-hud/setup.js install
```

Kiểm tra trạng thái cài đặt:

```bash
agy-retryctl setup status --json
```
