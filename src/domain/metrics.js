// Derived numbers for Progress, Journey and Share (pure). Nothing here invents data: every figure is computed only
// from check-ins that exist inside the requested window, and "not enough data" is reported as null, not as 0.
import { addDays, daysBetween } from './dates.js';
import { computeStreak } from './streak.js';
import { consistencyPct, currentDayIndex, lastLoggedWeight, latestWeight } from './journey.js';

/** Range presets offered on the Progress screen (days). "All" and "Custom" are separate selections. */
export const RANGE_PRESETS = [7, 14, 30, 60, 90];
export const MAX_CUSTOM_RANGE = 365;

/**
 * Resolves a range selection to a concrete window ending today.
 *   sel = { kind:'days', days:N } | { kind:'all' }
 * The window never starts before the journey does, so `elapsed` (days that really exist in the window) can be
 * smaller than `days` (days the user asked to see). That gap is what the UI must explain, not hide.
 */
export function resolveRange(journey, sel, today) {
  const sinceStart = Math.max(1, daysBetween(journey.start, today) + 1);
  const days = sel.kind === 'all' ? sinceStart : Math.max(1, Math.floor(sel.days));
  let start = journey.start;
  if (sel.kind !== 'all') {
    const s = addDays(today, -(days - 1));
    start = s < journey.start ? journey.start : s;
  }
  const elapsed = Math.max(0, daysBetween(start, today) + 1);
  return { kind: sel.kind, days, start, end: today, elapsed, journeyDay: currentDayIndex(journey, today), complete: elapsed >= days };
}

export function progressStats(user, sel, today) {
  const win = resolveRange(user.journey, typeof sel === 'number' ? { kind: 'days', days: sel } : sel, today);
  const inRange = Object.keys(user.checkins).sort().filter((d) => d >= win.start && d <= win.end);
  const streak = computeStreak(user.checkins, today);
  const waters = inRange.map((d) => user.checkins[d].water || 0);
  const weights = inRange.filter((d) => user.checkins[d].weight).map((d) => ({ d, w: user.checkins[d].weight }));
  const now = latestWeight(user);
  return {
    window: win,
    inRange,
    now,
    logged: lastLoggedWeight(user),
    change: now - user.journey.startWeight, // since starting
    windowChange: weights.length >= 2 ? weights[weights.length - 1].w - weights[0].w : null,
    weightCount: weights.length,
    streak: streak.current,
    streakInfo: streak,
    checkinCount: inRange.length,
    checkinDenominator: win.days,
    workouts: inRange.filter((d) => user.checkins[d].exercise).length,
    avgWaterMl: waters.length ? waters.reduce((a, b) => a + b, 0) / waters.length : null,
    // Share of the window's ELAPSED days that have a check-in (a 1-day-old journey with 1 check-in is 100% of 1 day,
    // and the UI says "of 1 elapsed day" rather than implying a full 7/30/90-day history).
    consistency: win.elapsed ? Math.round((inRange.length / win.elapsed) * 100) : null,
    journeyConsistency: consistencyPct(user, today),
  };
}

export function chartPoints(user, dates) {
  return dates.map((d) => ({ d, w: user.checkins[d].weight })).filter((p) => p.w);
}

/** What the share card may show. A metric with no real data is null and the card omits it. */
export function shareStats(user, today) {
  const dates = Object.keys(user.checkins);
  const streak = computeStreak(user.checkins, today);
  return {
    day: currentDayIndex(user.journey, today),
    duration: user.journey.duration,
    checkins: dates.length,
    streak: streak.current,
    streakStatus: streak.status,
    weight: lastLoggedWeight(user),
    avgWaterL: dates.length
      ? Number((dates.reduce((a, d) => a + (user.checkins[d].water || 0), 0) / dates.length / 1000).toFixed(1))
      : null,
    workouts: dates.filter((d) => user.checkins[d].exercise).length,
  };
}

/** Calendar cell class: c = complete, p = partial, m = missed, future. */
export function dayStatusClass(checkin, isFuture, waterGoal) {
  if (isFuture) return 'future';
  if (checkin && checkin.weight && checkin.water >= waterGoal * 0.8 && checkin.exercise) return 'c';
  if (checkin) return 'p';
  return 'm';
}
