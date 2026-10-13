// Next-account selection and rotation guards for the P1 supervisor.
// Quota objects are shaped like lib/accounts.js refreshAccountQuota results:
// {name, buckets:[{window, remainingFraction, resetAt}], nearestResetAt, error}.

function hasQuota5h(quota) {
  if (!quota || quota.error) return false;
  const b = (quota.buckets || []).find(x => x.window === '5h');
  return b ? b.remainingFraction > 0 : false;
}

/**
 * selectNextAccount({accounts, quotas, order, activeName, notBefore, now})
 *   => account | null
 * Walks `order` (falling back to registry order), skipping the active
 * account, errored/unknown quotas, exhausted 5h buckets and cooldowns.
 */
export function selectNextAccount({ accounts = [], quotas = new Map(), order = [], activeName = '', notBefore = new Map(), now = Date.now() }) {
  const byName = new Map(accounts.map(a => [a.name, a]));
  const seq = [...order.filter(n => byName.has(n)), ...accounts.map(a => a.name).filter(n => !order.includes(n))];
  for (const name of seq) {
    if (name === activeName) continue;
    if ((notBefore.get(name) || 0) > now) continue;
    if (!hasQuota5h(quotas.get(name))) continue;
    return byName.get(name);
  }
  return null;
}

/**
 * nextRotationAllowed({rotationsThisSession, lastRotationAt, policy, now})
 *   => {allowed: boolean, reason: string}
 */
export function nextRotationAllowed({ rotationsThisSession = 0, lastRotationAt = 0, policy = {}, now = Date.now() }) {
  const max = policy.maxRotationsPerSession ?? 8;
  if (rotationsThisSession >= max) return { allowed: false, reason: 'max-rotations' };
  const cooldownMs = (policy.rotationCooldownSec ?? 30) * 1000;
  if (now - lastRotationAt < cooldownMs) return { allowed: false, reason: 'cooldown' };
  return { allowed: true, reason: '' };
}
