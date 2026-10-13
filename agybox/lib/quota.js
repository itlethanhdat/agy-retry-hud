// Quota parsing for `agy -p "/usage" --output-format json` output.
// Accepts the statusline-style shape {quota: {name: {remaining_fraction, reset_time|reset_in_seconds}}}
// and a few tolerant variants. Pure functions, no I/O.
function parseReset(b, now) {
  if (typeof b?.reset_time === 'string') { const t = Date.parse(b.reset_time); if (Number.isFinite(t)) return t; }
  if (typeof b?.resetTime === 'string') { const t = Date.parse(b.resetTime); if (Number.isFinite(t)) return t; }
  if (Number.isFinite(b?.reset_in_seconds) && b.reset_in_seconds >= 0) return now + b.reset_in_seconds * 1000;
  if (Number.isFinite(b?.resetInSeconds) && b.resetInSeconds >= 0) return now + b.resetInSeconds * 1000;
  return NaN;
}
function windowOf(name) {
  const lower = String(name).toLowerCase();
  if (lower.includes('weekly')) return 'weekly';
  if (lower.includes('daily')) return 'daily';
  if (lower.includes('5h') || lower.includes('5-hour') || lower.includes('5_hour')) return '5h';
  return name;
}
/** payload: parsed JSON from /usage. Returns {buckets:[{name,window,remainingFraction,resetAt}], raw} */
export function parseUsagePayload(payload, now = Date.now()) {
  const buckets = [];
  const q = payload?.quota;
  if (q && typeof q === 'object' && !Array.isArray(q)) {
    for (const [name, b] of Object.entries(q)) {
      const f = b?.remaining_fraction ?? b?.remainingFraction;
      const resetAt = parseReset(b, now);
      if (!Number.isFinite(f) || f < 0 || f > 1 || !Number.isFinite(resetAt)) continue;
      buckets.push({ name, window: windowOf(name), remainingFraction: f, resetAt });
    }
  } else if (Array.isArray(payload?.buckets)) {
    for (const b of payload.buckets) {
      const f = b?.remaining_fraction ?? b?.remainingFraction;
      const resetAt = parseReset(b, now);
      if (!Number.isFinite(f) || f < 0 || f > 1 || !Number.isFinite(resetAt)) continue;
      buckets.push({ name: b.name || b.window || 'unknown', window: windowOf(b.name || b.window || ''), remainingFraction: f, resetAt });
    }
  }
  return { buckets, checkedAt: now };
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
