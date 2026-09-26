// Journey / streak / motivation logic (pure — every function takes `today` explicitly).
import { addDays, daysBetween } from './dates.js';
import { progressToward } from './goal.js';

export const DEFAULT_WATER_GOAL = 2500; // ml

export const MIN_JOURNEY_DAYS = 7;
export const MAX_JOURNEY_DAYS = 365;
export const PRESET_DURATIONS = [30, 60, 90];

/**
 * Validate a custom journey length typed by the user (string or number).
 * Whole numbers only, MIN..MAX. Returns { ok, value } or { ok:false, error }.
 */
export function parseDuration(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: false, error: 'Enter how many days.' };
  if (!/^\d+$/.test(s)) return { ok: false, error: 'Use whole numbers only.' };
  const n = Number(s);
  if (n < MIN_JOURNEY_DAYS) return { ok: false, error: `Choose at least ${MIN_JOURNEY_DAYS} days.` };
  if (n > MAX_JOURNEY_DAYS) return { ok: false, error: `Your journey can be up to ${MAX_JOURNEY_DAYS} days.` };
  return { ok: true, value: n };
}

export const waterGoalOf = (journey) => (journey && journey.waterGoal) || DEFAULT_WATER_GOAL;

/**
 * Day numbering: the START DATE IS DAY 1. So a journey of N days runs start .. start + (N - 1), and that last day
 * is the goal date. Everything (Home, Journey, Profile, Progress, Completion) uses these two helpers.
 * All arithmetic is on local calendar days (see dates.js) — never UTC.
 */
export function goalDate(journey) {
  return addDays(journey.start, journey.duration - 1);
}

export function currentDayIndex(journey, today) {
  return Math.max(1, Math.min(journey.duration, daysBetween(journey.start, today) + 1));
}

/** Most recent weight the user actually logged in a check-in, or null if none. */
export function lastLoggedWeight(user) {
  const keys = Object.keys(user.checkins).sort();
  for (let i = keys.length - 1; i >= 0; i--) {
    if (user.checkins[keys[i]].weight) return user.checkins[keys[i]].weight;
  }
  return null;
}

/** Current weight for display: last logged, else the starting weight from onboarding. */
export function latestWeight(user) {
  return lastLoggedWeight(user) ?? user.journey.startWeight;
}

export { calcStreak, computeStreak } from './streak.js';

export function consistencyPct(user, today) {
  const day = currentDayIndex(user.journey, today);
  const inJourney = Object.keys(user.checkins).filter((d) => d >= user.journey.start && d <= today).length;
  return Math.round((inJourney / day) * 100);
}

/** Share of the start->goal distance covered, clamped 0..100 (works for gaining and losing alike). */
export function goalProgressPct(journey, weight) {
  return progressToward(journey.startWeight, journey.goalWeight, weight);
}

export function weightDeltaText(startWeight, weight) {
  const lost = startWeight - weight;
  if (lost > 0) return `−${lost.toFixed(1)} kg since starting`;
  if (lost < 0) return `+${(-lost).toFixed(1)} kg since starting`;
  return 'Just getting started';
}

export function homeMotivation(day, dur, streak, pct, checkedIn = false) {
  if (day <= 1) return checkedIn ? 'Day one is done. Keep it going.' : 'Your journey starts today.';
  if (pct >= 100) return 'You did it. Goal reached.';
  if (pct >= 85) return "You're getting closer.";
  if (streak >= 7) return "You're on a roll.";
  if (day / dur >= 0.5) return "You're halfway there. Keep going.";
  return "You're building your rhythm.";
}

export function waterMessage(water, goal) {
  const ratio = (water || 0) / goal;
  let text;
  if (ratio >= 1.15) text = 'Goal reached — you went beyond your hydration goal.';
  else if (ratio >= 1) text = 'Hydration goal complete!';
  else if (ratio >= 0.75) text = 'Almost there.';
  else if (ratio >= 0.5) text = "You're halfway there. Keep going.";
  else if (ratio >= 0.25) text = "You're making progress.";
  else text = "Let's get started.";
  return { ratio, text, goalHit: ratio >= 1 };
}
