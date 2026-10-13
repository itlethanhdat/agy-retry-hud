// Quota parsing for `agy -p "/usage" --output-format json` output.
// Core statusline shape {quota: {name: {remaining_fraction, reset_time|reset_in_seconds}}}
// is parsed by the shared HUD parser (src/native.js#quotaFromStatus) — single
// source of truth. Tolerant extras the shared parser doesn't cover
// (camelCase keys, the buckets-array form, the 5_hour window name) are
// handled locally below. Pure functions, no I/O.
import { quotaFromStatus } from '../../src/native.js';

// Tolerant reset parsing for buckets the shared parser skipped
// (camelCase keys or mixed shapes). Checks all four key spellings so no
// shape the old parser accepted is lost.
function parseResetTolerant(b, now) {
  if (typeof b?.reset_time === 'string') { const t = Date.parse(b.reset_time); if (Number.isFinite(t)) return t; }
  if (typeof b?.resetTime === 'string') { const t = Date.parse(b.resetTime); if (Number.isFinite(t)) return t; }
  if (Number.isFinite(b?.reset_in_seconds) && b.reset_in_seconds >= 0) return now + b.reset_in_seconds * 1000;
  if (Number.isFinite(b?.resetInSeconds) && b.resetInSeconds >= 0) return now + b.resetInSeconds * 1000;
  return NaN;
}
// Full agybox window mapping. Identical to the shared parser's mapping
// (weekly/daily/5h/5-hour) plus the 5_hour spelling the shared parser
// doesn't recognize.
function windowOf(name) {
  const lower = String(name).toLowerCase();
  if (lower.includes('weekly')) return 'weekly';
  if (lower.includes('daily')) return 'daily';
  if (lower.includes('5h') || lower.includes('5-hour') || lower.includes('5_hour')) return '5h';
  return name;
}

/** payload: parsed JSON from /usage. Returns {buckets:[{name,window,remainingFraction,resetAt}], checkedAt} */
export function parseUsagePayload(payload, now = Date.now()) {
  const q = payload?.quota;
  if (q && typeof q === 'object' && !Array.isArray(q)) {
    // Core shape via the shared parser; re-apply agybox's window mapping
    // (no-op except for the 5_hour spelling) and restore the old reset-key
    // precedence: the shared parser only reads snake keys, so re-run the
    // tolerant parse on the original bucket (e.g. a camelCase `resetTime`
    // string must win over `reset_in_seconds`, as the old parser did).
    const shared = quotaFromStatus(payload, now).map(b => {
      const resetAt = parseResetTolerant(q[b.name], now);
      return { ...b, window: windowOf(b.name), resetAt: Number.isFinite(resetAt) ? resetAt : b.resetAt };
    });
    const seen = new Set(shared.map(b => b.name));
    const extra = [];
    for (const [name, b] of Object.entries(q)) {
      if (seen.has(name)) continue; // already parsed by the shared parser
      const f = b?.remaining_fraction ?? b?.remainingFraction;
      const resetAt = parseResetTolerant(b, now);
      if (!Number.isFinite(f) || f < 0 || f > 1 || !Number.isFinite(resetAt)) continue;
      extra.push({ name, window: windowOf(name), remainingFraction: f, resetAt });
    }
    return { buckets: [...shared, ...extra], checkedAt: now };
  }
  if (Array.isArray(payload?.buckets)) {
    const buckets = [];
    for (const b of payload.buckets) {
      const f = b?.remaining_fraction ?? b?.remainingFraction;
      // Single tolerant parse — exactly the old key precedence
      // (reset_time → resetTime → reset_in_seconds → resetInSeconds).
      const resetAt = parseResetTolerant(b, now);
      if (!Number.isFinite(f) || f < 0 || f > 1 || !Number.isFinite(resetAt)) continue;
      const name = b.name || b.window || 'unknown';
      buckets.push({ name, window: windowOf(b.name || b.window || ''), remainingFraction: f, resetAt });
    }
    return { buckets, checkedAt: now };
  }
  return { buckets: [], checkedAt: now };
}
export function nearestResetAt(buckets) {
  let min = Infinity;
  for (const b of buckets || []) if (Number.isFinite(b.resetAt) && b.resetAt < min) min = b.resetAt;
  return min === Infinity ? null : min;
}
export function isExhausted(buckets, window = '5h') {
  const b = (buckets || []).find(x => x.window === window);
  return b ? b.remainingFraction <= 0 : null; // null = unknown
}
export function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) || 0) / 1000);
  const s = Math.floor(total % 60), m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  const p = n => String(n).padStart(2, '0');
  if (h >= 24) return `${Math.floor(h / 24)}d ${p(h % 24)}:${p(m)}`;
  if (h > 0) return `${p(h)}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}
