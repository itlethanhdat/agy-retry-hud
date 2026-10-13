// Quota-exhaustion signal detection for supervised agy sessions.
// A line match alone never triggers a rotation — Task 5 (rotateOnce) always
// verifies via /usage before acting. Keep patterns conservative: missing a
// reworded error is safer than rotating on a false positive.
export const QUOTA_PATTERNS = [
  /(?:^|[^0-9])429(?:[^0-9]|$)/,
  /RESOURCE_EXHAUSTED/,
  /quota.{0,30}exceeded/,
  /rate.?limit/,
  /too many requests/,
  /(?:monthly|weekly|daily).{0,40}limit.{0,40}(?:reached|exceeded|exhausted)/,
  /upgrade.+to continue/,
].map(re => new RegExp(re.source, 'i'));

/** matchQuotaSignal(line: string) => boolean */
export function matchQuotaSignal(line) {
  if (typeof line !== 'string' || !line) return false;
  return QUOTA_PATTERNS.some(re => re.test(line));
}
