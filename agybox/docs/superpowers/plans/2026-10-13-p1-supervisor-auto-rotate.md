# P1 Supervisor Auto-Rotate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the P1 auto-rotate supervisor: while a user codes in a supervised `agy` TUI session, detect quota exhaustion, verify it, snapshot a handoff, and respawn `agy` under the next account with the session resumed.

**Architecture:** A `SupervisedSession` class owns one `docker exec -it` child process, tails its output through an injectable line matcher, and on a confirmed quota signal runs `rotateOnce`: verify via `/usage` JSON → pick next account → write handoff → graceful stop → respawn with `agy --resume`, falling back to a fresh session with the handoff summary injected. All Docker and process-spawning seams are injectable so every task is unit-testable without Docker.

**Tech Stack:** Node.js ≥ 18, ESM, zero runtime dependencies. Tests: `node --test test/*.test.js`.

**Spec:** `~/workspace/agybox/DESIGN-rotation.md` (§2 architecture, §3 registry/quota, §4 signal detection, §5 handoff, §6 state machine P1 subset, §8 notify, §9 safety). P1 explicitly excludes WAITING_RESET (that's P2) — when no account has quota, notify the user and keep the session stopped.

## Global Constraints

- Node.js >= 18 (`"engines"` in package.json); `"type": "module"` ESM only.
- Zero runtime dependencies — package.json must stay dependency-free; use node: builtins only.
- Tests run with `node --test test/*.test.js`; every task follows TDD (failing test first, watched fail, then pass).
- Tests must never touch the real `~/.agy-sandbox`: set `process.env.AGYBOX_ROOT` to a tmp dir in each test file that touches the registry.
- Docker is unavailable on the dev machine: any code path that shells to `docker` must be injectable/stubbable and degrade to a typed error object, never throw unhandled.
- Graceful stop order: write `/exit\n` to child stdin → wait up to 5000 ms → SIGTERM. No SIGKILL in P1.
- Never log or persist token material: handoffs, logs and errors may contain account *names* only, never `antigravity-oauth-token` contents.
- Never push to GitHub or merge without the human partner's explicit approval.
- Work happens in an isolated worktree created via superpowers:using-git-worktrees at execution time; baseline is commit `f2a7a42`.

## Review Focus

1. **Transient 429 that is not real exhaustion** (rate spike, retryable). A reasonable person expects no account switch for a blip. → Task 1 + Task 5 test: pattern match alone never rotates; rotation requires `/usage` verification confirming `remainingFraction == 0` on the relevant bucket.
2. **Quota verification hangs** (docker exec stalls). A reasonable person expects the session to survive, not freeze mid-rotation. → Task 5 test: `verifyTimeoutSec` enforced; on timeout the session keeps running and the signal is logged, not acted on.
3. **Next account's container is down.** A reasonable person expects the supervisor to try the following account, not die. → Task 5 test: container-down → skip to next candidate; none left → typed `{exhausted:true}` result and user notification, session stays stopped (P1 has no WAITING_RESET).
4. **`agy --resume` fails cross-account** (session identity coupled to account). A reasonable person expects to not lose their work context silently. → Task 5 test: resume exit non-zero → fallback spawns a fresh session with the handoff summary injected as the first message; the handoff file records which path was taken (`resumeMode: 'native' | 'handoff-inject'`).
5. **Supervisor dies mid-rotation, restart finds a lock.** A reasonable person expects no orphaned duplicate session. → Task 6 test: per-account lock file `{pid, startedAt}`; `agybox run` refuses when the lock's PID is alive, clears a stale lock (PID dead) and proceeds.

---

## File Structure

- Create: `lib/signals.js` — quota-exhaustion line matcher (Task 1).
- Create: `lib/handoff.js` — handoff object builder + atomic file writer (Task 2).
- Create: `lib/rotate.js` — `selectNextAccount` + `nextRotationAllowed` guards (Task 3).
- Create: `lib/supervisor.js` — `SupervisedSession` (spawn/watch/graceful-stop) and `rotateOnce` flow (Tasks 4, 5).
- Modify: `bin/agybox` — add `run [--account NAME]` and `rotate [NAME]` commands (Task 6).
- Create: `test/signals.test.js`, `test/handoff.test.js`, `test/rotate.test.js`, `test/supervisor.test.js`, `test/run-cli.test.js` (one per task).
- Modify: `README.md` — document `agybox run` / `agybox rotate` (Task 7).

`lib/accounts.js` (`refreshAccountQuota`) and `lib/quota.js` (`parseUsagePayload`) already exist from P0 and are consumed as-is; no changes planned.

---

### Task 1: Quota-exhaustion signal detection

**Files:**
- Create: `lib/signals.js`
- Test: `test/signals.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `matchQuotaSignal(line: string) => boolean`; `QUOTA_PATTERNS: RegExp[]` (exported for the reviewer/debugging).

**Spec values:** patterns (case-insensitive): `429`, `RESOURCE_EXHAUSTED`, `quota.{0,30}exceeded`, `rate.?limit`, `too many requests`, `monthly|weekly|daily` + `limit` within 40 chars + `reached|exceeded|exhausted`, `upgrade.+to continue`.

- [ ] **Step 1: Write the failing test** in `test/signals.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchQuotaSignal } from '../lib/signals.js';
test('matches known quota-exhaustion lines', () => {
  assert.equal(matchQuotaSignal('Error 429: RESOURCE_EXHAUSTED'), true);
  assert.equal(matchQuotaSignal('Quota exceeded for 5h window, please wait'), true);
  assert.equal(matchQuotaSignal('You have reached your weekly limit. Upgrade to continue.'), true);
});
test('does not match ordinary lines', () => {
  assert.equal(matchQuotaSignal('Compiling 42 files... done'), false);
  assert.equal(matchQuotaSignal('4294967296 bytes written'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/signals.test.js`
Expected: FAIL with "Cannot find module '../lib/signals.js'" (or matchQuotaSignal not defined).

- [ ] **Step 3: Implement `matchQuotaSignal(line: string) => boolean` and `QUOTA_PATTERNS` in `lib/signals.js`**

Approach: array of case-insensitive RegExp, `.some(re => re.test(line))`. Anchor the bare-number pattern as `(?:^|[^0-9])429(?:[^0-9]|$)` so `4294967296` does not match.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/signals.test.js`
Expected: PASS 2/2.

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js test/signals.test.js
git commit -m "feat: quota-exhaustion signal detection"
```

---

### Task 2: Handoff snapshot builder

**Files:**
- Create: `lib/handoff.js`
- Test: `test/handoff.test.js`

**Interfaces:**
- Consumes: nothing (takes plain data).
- Produces: `HANDOFF_SCHEMA_VERSION = 1`; `buildHandoff({sessionId, fromAccount, cwd, gitHead, gitDirty, summary, pendingTodos, interruptedTool, now}) => object`; `writeHandoff(dir, handoff) => filepath` (atomic write, mode 0o600, filename `<sessionId>-<now>.json`).

**Spec values (§5):** fields exactly: `schemaVersion, sessionId, fromAccount, cwd, gitHead, gitDirty[], summary, pendingTodos[], interruptedTool, resumeMode ('native'|'handoff-inject'|null, set by Task 5), createdAt`. Must never include token material — builder takes no token field by design.

- [ ] **Step 1: Write the failing test** in `test/handoff.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildHandoff, writeHandoff, HANDOFF_SCHEMA_VERSION } from '../lib/handoff.js';
test('buildHandoff produces the spec shape', () => {
  const h = buildHandoff({ sessionId: 'abc', fromAccount: 'acc1', cwd: '/w', gitHead: '9f3',
    gitDirty: ['a.ts'], summary: 'refactor auth', pendingTodos: ['lint'], interruptedTool: null, now: 1000 });
  assert.equal(h.schemaVersion, HANDOFF_SCHEMA_VERSION);
  assert.equal(h.sessionId, 'abc'); assert.equal(h.fromAccount, 'acc1');
  assert.deepEqual(h.gitDirty, ['a.ts']); assert.equal(h.createdAt, 1000);
  assert.ok(!('token' in h) && !JSON.stringify(h).includes('antigravity-oauth-token'));
});
test('writeHandoff writes atomically with 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  const fp = writeHandoff(dir, buildHandoff({ sessionId: 's1', fromAccount: 'a', cwd: '', gitHead: '', gitDirty: [], summary: '', pendingTodos: [], interruptedTool: null, now: 7 }));
  assert.ok(fs.existsSync(fp)); assert.equal((fs.statSync(fp).mode & 0o777), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).sessionId, 's1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.js`
Expected: FAIL with "Cannot find module '../lib/handoff.js'".

- [ ] **Step 3: Implement `buildHandoff`, `writeHandoff`, `HANDOFF_SCHEMA_VERSION` in `lib/handoff.js`**

Atomic write: write `<file>.<pid>.tmp` then `fs.renameSync`. `resumeMode` defaults to `null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/handoff.test.js`
Expected: PASS 2/2.

- [ ] **Step 5: Commit**

```bash
git add lib/handoff.js test/handoff.test.js
git commit -m "feat: handoff snapshot builder"
```

---

### Task 3: Next-account selection and rotation guards

**Files:**
- Create: `lib/rotate.js`
- Test: `test/rotate.test.js`

**Interfaces:**
- Consumes: quota objects shaped like `refreshAccountQuota` results: `{name, buckets, nearestResetAt, error}` (from `lib/accounts.js`).
- Produces: `selectNextAccount({accounts, quotas, order, activeName, notBefore, now}) => account | null`; `nextRotationAllowed({rotationsThisSession, lastRotationAt, policy, now}) => {allowed: boolean, reason: string}`.

**Spec values:** `policy = {order: string[], maxRotationsPerSession: 8, rotationCooldownSec: 30}` (from `config.rotation`). Skip rules in order: not in `order` list order otherwise; skip `activeName`; skip accounts with `error` (except treat `container-down` as skippable, not fatal); skip accounts whose 5h bucket `remainingFraction <= 0`; skip `notBefore.get(name) > now` (cooldown/flap map).

- [ ] **Step 1: Write the failing test** in `test/rotate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNextAccount, nextRotationAllowed } from '../lib/rotate.js';
const acc = n => ({ name: n });
const q = (f5, err) => err ? { name: '', error: err } : { buckets: [{ window: '5h', remainingFraction: f5, resetAt: 1 }] };
test('selects next account in order, skipping exhausted and active', () => {
  const r = selectNextAccount({ accounts: [acc('a'), acc('b'), acc('c')],
    quotas: new Map([['a', q(0)], ['b', q(0.5)], ['c', q(0.9)]]),
    order: ['a', 'b', 'c'], activeName: 'a', notBefore: new Map(), now: 0 });
  assert.equal(r.name, 'b');
});
test('returns null when all others exhausted', () => {
  const r = selectNextAccount({ accounts: [acc('a'), acc('b')],
    quotas: new Map([['a', q(0)], ['b', q(0)]]),
    order: ['a', 'b'], activeName: 'a', notBefore: new Map(), now: 0 });
  assert.equal(r, null);
});
test('respects notBefore cooldown map', () => {
  const r = selectNextAccount({ accounts: [acc('a'), acc('b')],
    quotas: new Map([['a', q(0)], ['b', q(0.5)]]),
    order: ['a', 'b'], activeName: 'a', notBefore: new Map([['b', 999]]), now: 0 });
  assert.equal(r, null);
});
test('nextRotationAllowed enforces max rotations and cooldown', () => {
  const policy = { maxRotationsPerSession: 2, rotationCooldownSec: 30 };
  assert.equal(nextRotationAllowed({ rotationsThisSession: 2, lastRotationAt: 0, policy, now: 1000 }).allowed, false);
  assert.equal(nextRotationAllowed({ rotationsThisSession: 0, lastRotationAt: 0, policy, now: 1000 }).allowed, false); // cooldown
  assert.equal(nextRotationAllowed({ rotationsThisSession: 0, lastRotationAt: 0, policy, now: 40000 }).allowed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rotate.test.js`
Expected: FAIL with "Cannot find module '../lib/rotate.js'".

- [ ] **Step 3: Implement `selectNextAccount` and `nextRotationAllowed` in `lib/rotate.js`**

`nextRotationAllowed` returns `{allowed:false, reason:'max-rotations'|'cooldown'}` or `{allowed:true, reason:''}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rotate.test.js`
Expected: PASS 4/4.

- [ ] **Step 5: Commit**

```bash
git add lib/rotate.js test/rotate.test.js
git commit -m "feat: next-account selection and rotation guards"
```

---

### Task 4: SupervisedSession — spawn, watch, graceful stop

**Files:**
- Create: `lib/supervisor.js` (class only in this task)
- Test: `test/supervisor.test.js`

**Interfaces:**
- Consumes: injectable `spawnFn(cmd, args, opts) => ChildProcess`-like (defaults to `node:child_process` `spawn`).
- Produces: `class SupervisedSession` with `start(cmd, args, opts)`, `on('output'|'exit', cb)`, `write(data)`, `gracefulStop(timeoutMs = 5000) => Promise<void>`, `isRunning()`.

**Spec values:** `gracefulStop` writes `/exit\n` to stdin, waits for `exit` event up to `timeoutMs`, then sends SIGTERM; resolves when the process exits. Output events carry `{stream: 'stdout'|'stderr', data: string}` chunks; the class buffers partial lines and emits `line` events per complete line (the watcher in Task 5 consumes lines).

- [ ] **Step 1: Write the failing test** in `test/supervisor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisedSession } from '../lib/supervisor.js';
// fake child: echoes stdin lines to stdout, exits 0 on receiving '/exit'
function fakeSpawn() {
  const handlers = {};
  const child = { stdin: { write(d) { if (String(d).trim() === '/exit') setImmediate(() => handlers.exit?.(0)); } },
    stdout: { on() {} }, stderr: { on() {} }, killed: false,
    kill(sig) { this.killed = sig; setImmediate(() => handlers.exit?.(null, sig)); },
    on(e, cb) { handlers[e] = cb; } };
  return child;
}
test('gracefulStop writes /exit and resolves on exit', async () => {
  const s = new SupervisedSession({ spawnFn: fakeSpawn });
  s.start('agy', []); let exited = false; s.on('exit', () => exited = true);
  await s.gracefulStop(1000);
  assert.equal(exited, true);
});
test('gracefulStop SIGTERMs after timeout', async () => {
  const children = [];
  const hanging = () => { const c = fakeSpawn(); const orig = c.stdin.write; c.stdin.write = () => {}; children.push(c); return c; };
  const s = new SupervisedSession({ spawnFn: hanging });
  s.start('agy', []);
  await s.gracefulStop(50);
  assert.equal(children[0].killed, 'SIGTERM');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/supervisor.test.js`
Expected: FAIL with "Cannot find module '../lib/supervisor.js'".

- [ ] **Step 3: Implement `SupervisedSession` in `lib/supervisor.js`**

Line buffering: accumulate per-stream buffers, split on `\n`, emit `line` with the text. Keep the implementation under ~120 lines.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/supervisor.test.js`
Expected: PASS 2/2.

- [ ] **Step 5: Commit**

```bash
git add lib/supervisor.js test/supervisor.test.js
git commit -m "feat: SupervisedSession spawn/watch/graceful-stop"
```

---

### Task 5: rotateOnce — verify, handoff, respawn

**Files:**
- Modify: `lib/supervisor.js` (append `rotateOnce`)
- Test: extend `test/supervisor.test.js` (new cases in same file, separate `test()` blocks)

**Interfaces:**
- Consumes: `matchQuotaSignal` (Task 1), `buildHandoff`/`writeHandoff` (Task 2), `selectNextAccount`/`nextRotationAllowed` (Task 3), `SupervisedSession` (Task 4), quota objects shaped like `refreshAccountQuota` results.
- Produces: `rotateOnce({session, activeAccount, accounts, getQuota, policy, rotState, handoffDir, now, spawnFor}) => Promise<{to, resumeMode} | {exhausted: true} | {kept: true, reason}>`.

**Spec values / flow (§6 P1):** on a matched line: 1) call `getQuota(activeAccount.name)` with timeout `policy.verifyTimeoutSec` (default 20s; injectable clock/timeout for tests); 2) if the 5h bucket still has quota → return `{kept:true, reason:'not-exhausted'}` (Review Focus 1); 3) on verify timeout/error → `{kept:true, reason:'verify-failed'}` (Review Focus 2); 4) `selectNextAccount` → null → `{exhausted:true}` (Review Focus 3: container-down candidates are skipped inside selection); 5) `buildHandoff` + `writeHandoff`; 6) `session.gracefulStop()`; 7) spawn new session via `spawnFor(account, resumeArgs)`: first try `['--resume', sessionId]`; if that child exits non-zero within 10s (injectable), fallback spawn `[]` and `session.write(handoffSummaryMessage + '\n')`; set `handoff.resumeMode` accordingly and rewrite the file (Review Focus 4).

- [ ] **Step 1: Write the failing tests** (append to `test/supervisor.test.js`):

```js
test('rotateOnce keeps session when verify shows quota remains', async () => {
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a' },
    accounts: [{ name: 'a' }, { name: 'b' }],
    getQuota: async () => ({ buckets: [{ window: '5h', remainingFraction: 0.5, resetAt: 1 }] }),
    policy: { order: ['a', 'b'], verifyTimeoutSec: 1, maxRotationsPerSession: 8, rotationCooldownSec: 0 },
    rotState: { rotationsThisSession: 0, lastRotationAt: 0 }, handoffDir: '/tmp/x', now: 100000,
    spawnFor: () => { throw new Error('must not spawn'); } });
  assert.deepEqual(r, { kept: true, reason: 'not-exhausted' });
});
test('rotateOnce rotates to next account and resumes', async () => {
  const spawned = [];
  const r = await rotateOnce({ session: fakeSession(), activeAccount: { name: 'a', container: 'agy-a' },
    accounts: [{ name: 'a', container: 'agy-a' }, { name: 'b', container: 'agy-b' }],
    getQuota: async () => ({ buckets: [{ window: '5h', remainingFraction: 0, resetAt: 1 }] }),
    policy: { order: ['a', 'b'], verifyTimeoutSec: 1, maxRotationsPerSession: 8, rotationCooldownSec: 0 },
    rotState: { rotationsThisSession: 0, lastRotationAt: 0 }, handoffDir: fs.mkdtempSync(path.join(os.tmpdir(), 'h2-')), now: 100000,
    spawnFor: (account, args) => { spawned.push([account.name, args]); return fakeSession(); } });
  assert.equal(r.to, 'b'); assert.equal(r.resumeMode, 'native');
  assert.deepEqual(spawned[0], ['b', ['--resume', r.sessionId]]);
});
test('rotateOnce returns exhausted when nobody has quota', async () => { /* ... assert.deepEqual(r, { exhausted: true }) */ });
```

(`fakeSession()` = minimal `{gracefulStop: async () => {}, write(){}}`; flesh out in the test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/supervisor.test.js`
Expected: FAIL — `rotateOnce` is not exported from `../lib/supervisor.js`.

- [ ] **Step 3: Implement `rotateOnce` in `lib/supervisor.js`**

Keep it orchestration-only; all decisions come from Tasks 1–3. Timeout helper: `Promise.race` with `setTimeout`. Handoff summary message for the fallback path: `` `Tiếp tục công việc từ handoff (account cũ: ${fromAccount}):\n${summary}\nTodos còn lại: ${pendingTodos.join(', ')}` ``.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/supervisor.test.js`
Expected: PASS (all Task 4 + Task 5 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/supervisor.js test/supervisor.test.js
git commit -m "feat: rotateOnce verify-handoff-respawn flow"
```

---

### Task 6: CLI wiring — `agybox run` and `agybox rotate`

**Files:**
- Modify: `bin/agybox`
- Test: create `test/run-cli.test.js` (spawns `bin/agybox` with `AGYBOX_ROOT` tmp dir + stub `docker` on PATH)

**Interfaces:**
- Consumes: `SupervisedSession`, `rotateOnce`, `matchQuotaSignal`, `selectNextAccount`, `nextRotationAllowed`, `loadConfig`, account registry.
- Produces: CLI commands `agybox run [--account NAME]` (starts supervised session; refuses if a live lock exists, clears stale lock — Review Focus 5) and `agybox rotate [NAME]` (one-shot: handoff + respawn under another account without the watcher). Lock file: `<sandboxRoot>/locks/<account>.json` = `{pid, startedAt}`.

**Spec values:** `run` resolves the account (flag or `rotation.order[0]`), spawns `docker exec -it <container> agy` via SupervisedSession, prints `⟳ <from> → <to> — <reason>` on rotation, and on `{exhausted:true}` prints `Tất cả account đều hết quota (P1: chờ tay).` then exits 3. `rotate [NAME]` with no NAME picks via `selectNextAccount`.

- [ ] **Step 1: Write the failing test** in `test/run-cli.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agybox-cli-'));
const BIN = new URL('../bin/agybox', import.meta.url).pathname;
function agybox(...args) { return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, AGYBOX_ROOT: ROOT } }); }
test('run refuses when docker is unavailable', () => {
  agybox('add', 'a', 'a@x'); // registry setup
  const r = agybox('run', '--account', 'a');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /docker/i);
});
test('rotate with unknown account errors', () => {
  const r = agybox('rotate', 'ghost');
  assert.notEqual(r.status, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/run-cli.test.js`
Expected: FAIL — `run`/`rotate` are "unknown command".

- [ ] **Step 3: Implement `run` and `rotate` in `bin/agybox`**

Wire the watcher: `session.on('line', line => { if (matchQuotaSignal(line)) void rotateOnce({...}) })`. Keep `bin/agybox` thin; move lock helpers into `lib/supervisor.js` as `acquireLock(root, account)` / `releaseLock` if the file grows — your call, but export them for the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/run-cli.test.js`
Expected: PASS 2/2.

- [ ] **Step 5: Commit**

```bash
git add bin/agybox test/run-cli.test.js lib/supervisor.js
git commit -m "feat: agybox run and rotate commands"
```

---

### Task 7: End-to-end rotation with stubbed docker + docs

**Files:**
- Test: create `test/e2e-rotate.test.js`
- Modify: `README.md` (document `run`/`rotate`, P1 scope note)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: a green end-to-end proof: with a stub `docker` script on PATH (responding to `exec <container> agy -p /usage --output-format json` with canned quota JSON per container) and `AGYBOX_ROOT` in tmp, drive `rotateOnce` through a scripted session: line `Error 429: RESOURCE_EXHAUSTED` → verify confirms acc-a exhausted → selects acc-b → handoff file exists with `resumeMode: 'native'` → new spawn got `--resume`.

- [ ] **Step 1: Write the failing test** in `test/e2e-rotate.test.js` (script it against `rotateOnce` + stub `getQuota` reading canned JSON files per account — no real docker needed; the docker seam is `getQuota`, already injected).

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { rotateOnce } from '../lib/supervisor.js';
test('full rotation loop with stubbed quota source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const quotas = { a: { buckets: [{ window: '5h', remainingFraction: 0, resetAt: 1 }] },
                   b: { buckets: [{ window: '5h', remainingFraction: 0.7, resetAt: 1 }] } };
  const events = [];
  const session = { async gracefulStop() { events.push('stopped'); }, write(d) { events.push('wrote:' + d.slice(0, 20)); } };
  const r = await rotateOnce({ session, activeAccount: { name: 'a', container: 'agy-a' },
    accounts: [{ name: 'a', container: 'agy-a' }, { name: 'b', container: 'agy-b' }],
    getQuota: async (name) => quotas[name],
    policy: { order: ['a', 'b'], verifyTimeoutSec: 1, maxRotationsPerSession: 8, rotationCooldownSec: 0 },
    rotState: { rotationsThisSession: 0, lastRotationAt: 0, sessionId: 'sess-1' },
    handoffDir: dir, now: 200000,
    spawnFor: (account, args) => { events.push(`spawn:${account.name}:${args.join(' ')}`); return session; } });
  assert.equal(r.to, 'b');
  assert.ok(events.includes('stopped'));
  assert.ok(events.some(e => e.startsWith('spawn:b:--resume sess-1')));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const h = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(h.resumeMode, 'native'); assert.equal(h.fromAccount, 'a');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/e2e-rotate.test.js`
Expected: FAIL — `rotateOnce` signature/behavior from Task 5 must accept `sessionId` via `rotState.sessionId` (if Task 5 didn't include it, this test defines the gap → rule it then).

- [ ] **Step 3: Adjust `rotateOnce`/`lib/supervisor.js` only as needed to satisfy the e2e contract** (no new features; conform to the test).

- [ ] **Step 4: Run the FULL suite**

Run: `npm test`
Expected: all tests pass (10 existing + new ones).

- [ ] **Step 5: Update README.md** — add `run`/`rotate` usage, P1 scope note ("P1 stops when all accounts are exhausted; WAITING_RESET is P2"), then commit:

```bash
git add test/e2e-rotate.test.js lib/supervisor.js README.md
git commit -m "test: e2e rotation loop; docs for run/rotate"
```

---

## Self-Review

1. **Spec coverage:** §2 architecture → Tasks 4, 5, 6. §3 registry/quota → reused P0 `lib/accounts.js` (no task needed; Task 5 consumes its shape). §4 signal detection → Task 1. §5 handoff → Task 2 (+ resumeMode set in Task 5). §6 state machine P1 subset (ACTIVE→VERIFYING→SELECT_NEXT→HANDOFF→RESPAWN; ALL_EXHAUSTED → notify, no WAITING_RESET) → Tasks 3, 5, 6. §8 notify → Task 6 console lines. §9 safety (graceful stop, lock, no token in logs) → Tasks 4, 6, Task 2 test asserts no token material. Gaps: none for P1 scope.
2. **Step scan:** each step names one action with a checkable result; test steps include exact assertions; code steps give exact signatures; verification steps give the command and expected output. Task 7 Step 3 is a conformance step, not new behavior — acceptable as the e2e contract may surface a signature gap from Task 5 (ruled at that point, ledgered).
3. **Type consistency:** `rotateOnce` options shape is defined once in Task 5 and reused verbatim in Task 7 (`{session, activeAccount, accounts, getQuota, policy, rotState, handoffDir, now, spawnFor}`); `rotState.sessionId` added by Task 7's contract — Task 5's implementation must read session id from `rotState.sessionId` (flagged in Task 7 Step 2 as the expected ruling point). Quota object shape `{name, buckets, nearestResetAt, error}` matches `lib/accounts.js` `refreshAccountQuota` output. `SupervisedSession` events (`output`/`line`/`exit`) are produced in Task 4 and consumed in Task 6.
4. **Review Focus:** item 1 → Task 1 test (no-match cases) + Task 5 `not-exhausted` test. Item 2 → Task 5 `verify-failed` path (timeout via `policy.verifyTimeoutSec`). Item 3 → Task 5 `exhausted:true` test + Task 3 skip-`container-down` rule. Item 4 → Task 5 fallback-spawn test (add: resume child exits non-zero → `resumeMode: 'handoff-inject'`; the implementer adds this test in Task 5 Step 1 following the same style). Item 5 → Task 6 lock test (add: stale lock cleared, live lock refused).
5. **Proportion:** plan is longer than the ~150-line implementation it describes, but the bulk is test code the implementer copies — per the skill, test steps carry exact assertions as code, which is intentional. No task writes a body the signature+tests already determine.

One judgment call recorded here (not a runtime ruling): the plan keeps P1 CLI-only; hub actions (H1) are a separate plan. The `broadcast` hook in `hub/server.js` already exists for H1 to reuse.
