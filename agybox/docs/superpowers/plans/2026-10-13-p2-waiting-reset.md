# P2 Waiting-Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When all accounts are quota-exhausted, the supervisor automatically switches to the account with the nearest reset time, waits until reset, verifies quota, and resumes the session — no manual watching.

**Architecture:** Extend the P1 `rotateOnce` flow: on `{exhausted:true}`, `agybox run` calls the new `enterWaitingReset` (in `lib/supervisor.js`) instead of exiting. It gathers per-account quotas, picks the nearest reset (5h bucket preferred, then weekly), holds that account's lock, writes a state file, sleeps until `resetAt + resetBufferSec` while polling a cancel flag, then re-verifies (never trusting the timer alone — machine sleep) and respawns via the existing `spawnFor`/`--resume` path with handoff-inject fallback. All time and cancel-check seams are injectable for unit tests; the e2e uses the fake-docker helper with a quota-ok marker file.

**Tech Stack:** Node.js ≥ 18, ESM, zero runtime dependencies. Tests: `node --test test/*.test.js`.

**Spec:** `~/workspace/agybox/DESIGN-rotation.md` (§6 state machine: ALL_EXHAUSTED → PICK_NEAREST_RESET → SWITCH → WAITING_RESET → VERIFY_QUOTA → RESPAWN; §7 scheduler incl. sleep/hibernate rule; §8 countdown display; §9 safety).

## Global Constraints

- Node.js >= 18; `"type": "module"` ESM only; zero runtime dependencies.
- Tests run with `node --test test/*.test.js`; TDD every task (failing test first, watched fail, then pass).
- Tests must never touch the real `~/.agy-sandbox`: `AGYBOX_ROOT` tmp dir per test file.
- Docker unavailable on dev machine: docker-touching seams stay injectable; e2e goes through `test/helpers/fake-docker.sh` (extend it, don't fork it).
- Never log or persist token material; handoffs keep the Task-2 (P1) no-token invariant.
- Time is always injectable: no raw `Date.now()`/`setTimeout` in orchestration logic — take a `clock = {now(), sleep(ms)}` param defaulting to real timers.
- Never push to GitHub or merge without the human partner's explicit approval.
- Work happens in an isolated worktree created via superpowers:using-git-worktrees at execution time; baseline is the P1 merge (branch `feat/p1-supervisor-auto-rotate` merged to master, or master HEAD if the human kept it as-is — confirm at execution).

## Review Focus

1. **resetAt already in the past** (clock skew, slow verify). A reasonable person expects immediate re-verify, not a negative sleep or an exception. → Task 2 test: `wakeAt <= now` → skip sleep, verify now.
2. **All resetAt unknown** (telemetry failed everywhere). A reasonable person expects a bounded give-up, not an infinite wait. → Task 3 test: unknown resets → recheck up to 3 times (`waitRecheckSec` apart), then return `{givenUp:true}` with a clear message.
3. **Stale cancel flag from a previous run.** A reasonable person expects a fresh wait not to cancel instantly. → Task 4 test: entering WAITING_RESET deletes any pre-existing flag file first.
4. **Machine slept through the timer.** A reasonable person expects the supervisor to notice the quota may have reset long ago (or the reset moved) and check before resuming. → Task 3 test: injected clock jumps past wakeAt → verify is still called before spawn; spawn only on confirmed quota.
5. **Two `agybox run` processes waiting on the same account.** A reasonable person expects the second to be refused, not a duplicate session at wake. → Task 4 test: waiting holds the account lock (acquire before sleep, release after resume/exit); a second `run --account <same>` is refused while waiting.

---

## File Structure

- Create: `lib/wait.js` — `pickNearestResetAccount(accounts, quotas)` (Task 1).
- Create: `lib/wait.js` (same file) — `waitUntilWake({wakeAt, cancelFile, pollMs, onTick, clock})` (Task 2).
- Modify: `lib/supervisor.js` — append `enterWaitingReset({...})` (Task 3).
- Modify: `bin/agybox` — wire `{exhausted:true}` → waiting; add `cancel-wait` command; state file writes (Task 4).
- Modify: `test/helpers/fake-docker.sh.js` — `FAKE_RESET_IN_SECONDS` env + quota-ok marker file (Task 5).
- Create: `test/wait.test.js`; extend: `test/supervisor.test.js` (enterWaitingReset), `test/run-e2e.test.js` (waiting e2e).
- Modify: `README.md` — P2 docs (Task 6).

`rotateOnce`, `SupervisedSession`, locks, and `refreshAccountQuota` are consumed as-is from P1.

---

### Task 1: Nearest-reset selection (pure)

**Files:**
- Create: `lib/wait.js`
- Test: `test/wait.test.js`

**Interfaces:**
- Consumes: quota objects shaped like `refreshAccountQuota` results.
- Produces: `pickNearestResetAccount(accounts, quotas) => {account, resetAt, window} | null`.

**Spec values:** prefer the 5h bucket's resetAt; fall back to weekly, then any bucket with a finite resetAt; skip accounts with `error` or no finite resetAt; ties → earliest in `accounts` order.

- [ ] **Step 1: Write the failing test** in `test/wait.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNearestResetAccount } from '../lib/wait.js';
const acc = n => ({ name: n });
const q = (w5, ww) => ({ buckets: [
  ...(w5 ? [{ window: '5h', remainingFraction: 0, resetAt: w5 }] : []),
  ...(ww ? [{ window: 'weekly', remainingFraction: 0, resetAt: ww }] : []),
]});
test('picks the account with the nearest 5h reset', () => {
  const r = pickNearestResetAccount([acc('a'), acc('b')],
    new Map([['a', q(3000)], ['b', q(1000)]]));
  assert.equal(r.account.name, 'b'); assert.equal(r.resetAt, 1000); assert.equal(r.window, '5h');
});
test('falls back to weekly when no 5h reset is known', () => {
  const r = pickNearestResetAccount([acc('a'), acc('b')],
    new Map([['a', q(null, 5000)], ['b', q(9000)]]));
  assert.equal(r.account.name, 'a'); assert.equal(r.window, 'weekly');
});
test('returns null when no reset time is known', () => {
  assert.equal(pickNearestResetAccount([acc('a')], new Map([['a', { error: 'x' }]]), null);
  assert.equal(pickNearestResetAccount([acc('a')], new Map([['a', { buckets: [] }]]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wait.test.js`
Expected: FAIL with "Cannot find module '../lib/wait.js'".

- [ ] **Step 3: Implement `pickNearestResetAccount` in `lib/wait.js`**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/wait.test.js`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add lib/wait.js test/wait.test.js
git commit -m "feat: nearest-reset account selection"
```

---

### Task 2: waitUntilWake — timer with cancel polling and ticks

**Files:**
- Modify: `lib/wait.js` (append)
- Test: extend `test/wait.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `waitUntilWake({wakeAt, cancelFile, pollMs = 5000, onTick, clock}) => Promise<{woken:true} | {cancelled:true}>`.

**Spec values:** `clock = {now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms))}` default; tests inject a fake clock. If `wakeAt <= clock.now()` → return `{woken:true}` immediately (Review Focus 1). Poll `cancelFile` existence every `pollMs`; call `onTick(msRemaining)` each poll; on cancel file found → delete it, return `{cancelled:true}`.

- [ ] **Step 1: Write the failing tests** (append to `test/wait.test.js`):

```js
test('waitUntilWake wakes at the time', async () => {
  let t = 1000; const sleeps = [];
  const clock = { now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; } };
  const r = await waitUntilWake({ wakeAt: 5000, cancelFile: '/nonexistent-xyz', pollMs: 1000, clock });
  assert.deepEqual(r, { woken: true });
  assert.ok(t >= 5000);
});
test('waitUntilWake returns immediately when wakeAt is past', async () => {
  let slept = false;
  const clock = { now: () => 9000, sleep: async () => { slept = true; } };
  const r = await waitUntilWake({ wakeAt: 5000, cancelFile: '/nonexistent-xyz', clock });
  assert.deepEqual(r, { woken: true }); assert.equal(slept, false);
});
test('waitUntilWake observes the cancel file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-'));
  const cancelFile = path.join(dir, 'cancel');
  let t = 0;
  const clock = { now: () => t, sleep: async ms => { t += ms; if (t >= 3000) fs.writeFileSync(cancelFile, ''); } };
  const r = await waitUntilWake({ wakeAt: 99999, cancelFile, pollMs: 1000, clock });
  assert.deepEqual(r, { cancelled: true });
  assert.ok(!fs.existsSync(cancelFile), 'cancel file is consumed');
});
```

(`fs`, `os`, `path` imports added to the test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wait.test.js`
Expected: FAIL — `waitUntilWake` is not exported.

- [ ] **Step 3: Implement `waitUntilWake` in `lib/wait.js`**

Loop: `while (clock.now() < wakeAt) { if (exists(cancelFile)) { unlink; return {cancelled:true}; } onTick?.(wakeAt - clock.now()); await clock.sleep(min(pollMs, wakeAt - now)); }` then final cancel check, return `{woken:true}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wait.test.js`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/wait.js test/wait.test.js
git commit -m "feat: waitUntilWake timer with cancel polling"
```

---

### Task 3: enterWaitingReset orchestration

**Files:**
- Modify: `lib/supervisor.js` (append `enterWaitingReset`)
- Test: extend `test/supervisor.test.js`

**Interfaces:**
- Consumes: `pickNearestResetAccount`, `waitUntilWake` (Tasks 1–2), `SupervisedSession`/`spawnFor` conventions from P1, quota shape from `refreshAccountQuota`.
- Produces: `enterWaitingReset({accounts, getQuota, policy, rotState, handoffDir, spawnFor, stateFile, cancelFile, onTick, clock, now}) => Promise<{resumed, account, session} | {cancelled:true} | {givenUp:true}>`.

**Spec values / flow:**
1. Gather quotas: `getQuota(name)` per account (with the same `withTimeout` as P1, `policy.verifyTimeoutSec`).
2. `pickNearestResetAccount` → null → recheck up to 3 times, `policy.waitRecheckSec` (default 300) apart → still null → return `{givenUp:true}` (Review Focus 2).
3. `wakeAt = resetAt + (policy.resetBufferSec ?? 90) * 1000`.
4. Write state file `{phase:'waiting', account, wakeAt, updatedAt}` (atomic JSON; consumed by hub H1 later).
5. `waitUntilWake({wakeAt, cancelFile, onTick, clock})` → `{cancelled:true}` → return it (lock released by caller).
6. After wake: re-verify that account's quota (Review Focus 4 — never trust the timer). If 5h has quota → `spawnFor(account, ['--resume', rotState.sessionId])` with the same settle/fallback logic as `rotateOnce` (extract a shared `spawnWithResume(spawnFor, account, sessionId, handoff, policy)` helper used by both — no duplication). Still exhausted → loop back to step 1, up to `policy.maxWaitCycles ?? 5`, then `{givenUp:true}`.
7. On success return `{resumed:true, account: name, session}`.

- [ ] **Step 1: Write the failing tests** (append to `test/supervisor.test.js`):

```js
test('enterWaitingReset resumes after wake when quota returns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-'));
  let t = 0; const clock = { now: () => t, sleep: async ms => { t += ms; } };
  let quotaCalls = 0;
  const getQuota = async () => (++quotaCalls === 1
    ? { buckets: [{ window: '5h', remainingFraction: 0, resetAt: 1000 }] }
    : { buckets: [{ window: '5h', remainingFraction: 0.6, resetAt: 99999 }] });
  const spawned = [];
  const r = await enterWaitingReset({
    accounts: [{ name: 'a', container: 'agy-a' }], getQuota,
    policy: { verifyTimeoutSec: 1, resetBufferSec: 0, waitRecheckSec: 1, maxWaitCycles: 3 },
    rotState: { sessionId: 's-wait' }, handoffDir: dir,
    spawnFor: (a, args) => { spawned.push(args); return fakeSession(); },
    stateFile: path.join(dir, 'state.json'), cancelFile: path.join(dir, 'cancel'),
    clock, now: 0 });
  assert.equal(r.resumed, true); assert.equal(r.account, 'a');
  assert.deepEqual(spawned[0], ['--resume', 's-wait']);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(st.phase, 'waiting'); assert.equal(st.account, 'a');
});

test('enterWaitingReset gives up when reset is never known', async () => {
  let t = 0; const clock = { now: () => t, sleep: async ms => { t += ms; } };
  const r = await enterWaitingReset({
    accounts: [{ name: 'a' }], getQuota: async () => ({ error: 'x' }),
    policy: { verifyTimeoutSec: 1, waitRecheckSec: 1, maxWaitCycles: 2 },
    rotState: {}, handoffDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wr-')),
    spawnFor: () => { throw new Error('must not spawn'); },
    stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-')), 's.json'),
    cancelFile: '/nonexistent-xyz', clock, now: 0 });
  assert.deepEqual(r, { givenUp: true });
});
```

(`fakeSession` already exists in that file from P1 Task 5.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/supervisor.test.js`
Expected: FAIL — `enterWaitingReset` is not exported.

- [ ] **Step 3: Implement `enterWaitingReset` (+ shared `spawnWithResume` helper) in `lib/supervisor.js`**

Refactor `rotateOnce` to use `spawnWithResume` too — behavior unchanged, existing tests must stay green.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/supervisor.test.js`
Expected: PASS (all P1 + new cases).

- [ ] **Step 5: Commit**

```bash
git add lib/supervisor.js test/supervisor.test.js
git commit -m "feat: enterWaitingReset orchestration"
```

---

### Task 4: CLI wiring — waiting in `run`, `cancel-wait`, lock discipline

**Files:**
- Modify: `bin/agybox`
- Test: extend `test/run-cli.test.js`

**Interfaces:**
- Consumes: `enterWaitingReset`, `acquireLock`/`releaseLock`, state file helpers (inline in bin).
- Produces: `agybox run` enters waiting instead of exiting 3 on `{exhausted:true}`; `agybox cancel-wait` creates the flag file; waiting holds the nearest-reset account's lock (Review Focus 5).

**Spec values:**
- State file: `<root>/supervisor-state.json` (atomic write). Cancel flag: `<root>/cancel-wait`.
- On entering WAITING_RESET: delete any pre-existing cancel flag (Review Focus 3); print `⏳ tất cả hết quota — chờ <account> reset sau <countdown> (gõ \`agybox cancel-wait\` để dừng chờ)`.
- `onTick`: reprint the countdown line every 30s (throttle inside bin, not in lib).
- After `enterWaitingReset` returns `{resumed, account, session}`: transfer lock to that account (same pattern as P1 rotation), `watch(session)`, continue.
- `{cancelled:true}` → print `đã hủy chờ.`, release lock, exit 0.
- `{givenUp:true}` → print reason, release lock, exit 3.
- `agybox cancel-wait`: touch the flag file; if no state file with `phase:'waiting'` → print `không có phiên nào đang chờ.` and exit 1.

- [ ] **Step 1: Write the failing tests** (append to `test/run-cli.test.js`):

```js
test('cancel-wait creates the flag file', () => {
  const r = agybox('cancel-wait');
  // no one is waiting in this fresh ROOT, but the flag must exist for the poller
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(ROOT, 'cancel-wait')));
});

test('run holds the waiting lock: second run for same account is refused', () => {
  // simulate a waiting supervisor by holding b's lock with a live pid
  fs.mkdirSync(path.join(ROOT, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'locks', 'b.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const r = agybox('run', '--account', 'b');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /already/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/run-cli.test.js`
Expected: FAIL — `cancel-wait` is "unknown command".

- [ ] **Step 3: Implement in `bin/agybox`**

Replace the `{exhausted:true}` branch in `doRotate` with the waiting flow. Keep the P1 rotation path untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/run-cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/agybox test/run-cli.test.js
git commit -m "feat: waiting state in run, cancel-wait command"
```

---

### Task 5: E2E — wait for reset, then auto-resume

**Files:**
- Modify: `test/helpers/fake-docker.js` (add `FAKE_RESET_IN_SECONDS`, quota-ok marker)
- Test: extend `test/run-e2e.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: a green proof of the whole P2 story with no real Docker.

**Fake-docker extensions:**
- Env `FAKE_RESET_IN_SECONDS` (default 3600) → value used in `/usage` `reset_in_seconds`.
- Env `FAKE_QUOTA_OK_FILE`: when that file exists, `/usage` reports `remaining_fraction: 0.7` for every container (simulating "reset happened"); otherwise agy-a reports 0 and others report per current behavior. (Keep the a/b distinction for the P1 e2e: only apply the marker override when the env var is set.)

**E2E test** (append to `test/run-e2e.test.js`): fresh `AGYBOX_ROOT`; pre-write `config.json` with `rotation: {resetBufferSec: 1, waitRecheckSec: 1, verifyTimeoutSec: 1}`; env `FAKE_RESET_IN_SECONDS=2`, `FAKE_QUOTA_OK_FILE=<tmp>/ok` (not created yet); add accounts a, b; spawn `agybox run`:
1. a's session prints the 429 line → verify: a exhausted; b — with marker absent — also exhausted → `{exhausted:true}` → enters WAITING_RESET (assert output contains `⏳` and the state file shows `phase:'waiting'`).
2. After 1s the test creates the marker file (reset "happens").
3. Wake at ~3s → verify a → quota ok → respawn `--resume` → assert output contains `tiếp tục` (the message printed on resume — define exact copy in Task 4: `✓ <account> đã có quota sau reset — tiếp tục session`).
4. Fake session for the respawn exits after its idle timeout → run exits 0; locks released.

- [ ] **Step 1: Write the failing test**

Follow the P1 e2e style already in the file (spawn, poll, assert). Run it → FAIL (no waiting: current code prints `Tất cả account đều hết quota` and exits 3).

- [ ] **Step 2: Implement** — Tasks 1–4 already did; this step is the fake-docker extension + config plumbing. If the e2e still fails, debug the wiring (systematic-debugging), not the test's expectations.

- [ ] **Step 3: Run the e2e**

Run: `node --test test/run-e2e.test.js`
Expected: PASS (both P1 and P2 cases).

- [ ] **Step 4: Commit**

```bash
git add test/helpers/fake-docker.js test/run-e2e.test.js
git commit -m "test: e2e wait-for-reset and auto-resume"
```

---

### Task 6: Docs + full suite

**Files:**
- Modify: `README.md`
- (no new test file; verification is the suite)

- [ ] **Step 1: Update README.md** — P2 section: the waiting flow, `cancel-wait`, state file location, countdown display, give-up conditions, and the machine-sleep note.

- [ ] **Step 2: Run the FULL suite**

Run: `npm test`
Expected: all green (P0 10 + P1 28 + P2 new).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: P2 waiting-reset"
```

---

## Self-Review

1. **Spec coverage:** §6 (ALL_EXHAUSTED→PICK_NEAREST_RESET→SWITCH→WAITING_RESET→VERIFY→RESPAWN) → Tasks 1, 3, 4. §7 (timer, buffer, sleep/hibernate, recompute) → Tasks 2, 3. §8 (countdown) → Task 4 onTick throttle. §9 (locks, graceful) → reused P1 + Task 4 lock-during-wait. Gaps: hub countdown segment is H1, not P2 — correctly excluded.
2. **Step scan:** each step is one action with a checkable result; test steps carry exact assertions; Task 5 Step 2 explicitly scopes debugging to wiring. The `spawnWithResume` extraction in Task 3 is a refactor step — allowed post-green (P1 tests stay green proves no behavior change).
3. **Type consistency:** `enterWaitingReset` options mirror `rotateOnce`'s (`{accounts, getQuota, policy, rotState, handoffDir, spawnFor}`) plus `{stateFile, cancelFile, onTick, clock, now}`. Return shapes are disjoint: `{resumed, account, session}` / `{cancelled:true}` / `{givenUp:true}` — no overlap with `rotateOnce`'s `{to...}` / `{exhausted:true}` / `{kept...}`.
4. **Review Focus:** item 1 → Task 2 past-wakeAt test. Item 2 → Task 3 givenUp test. Item 3 → Task 4 (delete pre-existing flag on entry; test via cancel-wait then a fresh wait — the implementer adds this assertion in Task 4 Step 1 following the same style). Item 4 → Task 3 clock-jump test (add: clock jumps 1h past wakeAt → verify still called before spawn). Item 5 → Task 4 lock test.
5. **Proportion:** test code dominates, as intended by the skill (assertions as code). No production body is written in the plan beyond signatures and the small `waitUntilWake` loop sketch, which the tests fully determine.
