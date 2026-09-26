// Date helpers. All dates are local calendar days as 'YYYY-MM-DD' strings
// (the prototype used toISOString(), which is UTC and drifts near midnight).
const pad = (n) => String(n).padStart(2, '0');

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseDate(s) {
  return new Date(s + 'T00:00:00');
}
export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
export function formatLongDate(dateStr) {
  return parseDate(dateStr).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

/** Long date with weekday-free year, e.g. "26 Sep 2026" (local calendar day, never UTC-shifted). */
export function formatDate(dateStr) {
  return parseDate(dateStr).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
