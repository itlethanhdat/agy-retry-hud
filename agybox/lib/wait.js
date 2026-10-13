// P2 waiting-reset helpers: nearest-reset selection and the wake timer.
import fs from 'node:fs';

/**
 * pickNearestResetAccount(accounts, quotas: Map<name, quota>) =>
 *   {account, resetAt, window} | null
 * Each account's nearest reset is its 5h bucket first, then weekly, then any
 * other bucket with a finite resetAt; the earliest across accounts wins.
 * Skips accounts with errors or no known reset. Ties → earliest in `accounts`.
 */
export function pickNearestResetAccount(accounts = [], quotas = new Map()) {
  let best = null;
  for (const account of accounts) {
    const buckets = quotas.get(account.name)?.buckets || [];
    let pick = null;
    for (const window of ['5h', 'weekly']) {
      const resetAt = buckets.find(b => b.window === window)?.resetAt;
      if (typeof resetAt === 'number' && Number.isFinite(resetAt)) { pick = { resetAt, window }; break; }
    }
    if (!pick) {
      for (const b of buckets) {
        const resetAt = b?.resetAt;
        if (typeof resetAt === 'number' && Number.isFinite(resetAt) && (!pick || resetAt < pick.resetAt)) {
          pick = { resetAt, window: b.window };
        }
      }
    }
    if (pick && (!best || pick.resetAt < best.resetAt)) {
      best = { account, resetAt: pick.resetAt, window: pick.window };
    }
  }
  return best;
}

const realClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

/**
 * waitUntilWake({wakeAt, cancelFile, pollMs, onTick, clock}) =>
 *   {woken:true} | {cancelled:true}
 * Sleeps until wakeAt (epoch ms), polling for the cancel file every pollMs.
 * onTick(msRemaining) fires each poll for countdown display. A present cancel
 * file is consumed (deleted) and yields {cancelled:true}. clock is injectable
 * for tests: {now(), sleep(ms)}.
 */
export async function waitUntilWake({ wakeAt, cancelFile, pollMs = 5000, onTick, clock = realClock }) {
  const consumeCancel = () => {
    if (!cancelFile) return false;
    try { fs.unlinkSync(cancelFile); return true; }
    catch (e) { if (e.code !== 'ENOENT') throw e; return false; }
  };
  while (clock.now() < wakeAt) {
    if (consumeCancel()) return { cancelled: true };
    try { onTick?.(wakeAt - clock.now()); } catch {}
    await clock.sleep(Math.min(pollMs, Math.max(0, wakeAt - clock.now())));
  }
  if (consumeCancel()) return { cancelled: true };
  return { woken: true };
}
