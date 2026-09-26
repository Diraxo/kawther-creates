// Achievement definitions and evaluation (pure). Every unlock condition is real and documented here;
// nothing is "unlocked" because it merely exists in this list.
//
//   first       1+ saved check-ins.
//   d3/d7/d14   the LONGEST run of consecutive check-in days (see streak.js `best`) reaches 3 / 7 / 14.
//   hydrated    7 days on which the water logged met the user's hydration goal.
//   active      4 check-ins with a logged workout inside any 7-day window.
//   consistent  80%+ of the journey days so far have a check-in, AND at least 7 check-ins
//               (80% of a single day is not consistency).
import { daysBetween } from './dates.js';
import { consistencyPct, waterGoalOf } from './journey.js';
import { computeStreak } from './streak.js';

export const CONSISTENT_MIN_CHECKINS = 7;

export function maxWorkoutsInWeek(checkins) {
  const dates = Object.keys(checkins).sort();
  let best = 0;
  for (let i = 0; i < dates.length; i++) {
    let cnt = 0;
    for (let j = i; j < dates.length; j++) {
      if (daysBetween(dates[i], dates[j]) < 7 && checkins[dates[j]].exercise) cnt++;
    }
    best = Math.max(best, cnt);
  }
  return best;
}

/** Everything an achievement test needs, computed once. */
export function achievementContext(user, today) {
  const goal = waterGoalOf(user.journey);
  const list = Object.values(user.checkins);
  const streak = computeStreak(user.checkins, today);
  return {
    checkinCount: list.length,
    streak: streak.current,
    bestStreak: streak.best,
    hydratedDays: list.filter((c) => (c.water || 0) >= goal).length,
    maxWorkoutsInWeek: maxWorkoutsInWeek(user.checkins),
    consistency: consistencyPct(user, today),
  };
}

export const ACH_DEFS = [
  { id: 'first', ic: 'leaf', t: 'First Step', d: 'Completed your first check-in.',
    test: (x) => x.checkinCount >= 1, prog: (x) => [Math.min(1, x.checkinCount), 1] },
  { id: 'd3', ic: 'heart', t: '3-Day Streak', d: '3 consecutive check-in days.',
    test: (x) => x.bestStreak >= 3, prog: (x) => [Math.min(x.bestStreak, 3), 3] },
  { id: 'd7', ic: 'flame', t: '7-Day Fire', d: '7 consecutive check-in days.',
    test: (x) => x.bestStreak >= 7, prog: (x) => [Math.min(x.bestStreak, 7), 7] },
  { id: 'd14', ic: 'bolt', t: '14-Day Streak', d: '14 consecutive check-in days.',
    test: (x) => x.bestStreak >= 14, prog: (x) => [Math.min(x.bestStreak, 14), 14] },
  { id: 'hydrated', ic: 'drop', t: 'Hydrated', d: 'Hit your hydration goal on 7 days.',
    test: (x) => x.hydratedDays >= 7, prog: (x) => [Math.min(7, x.hydratedDays), 7] },
  { id: 'active', ic: 'run', t: 'Active Week', d: '4 workouts within one week.',
    test: (x) => x.maxWorkoutsInWeek >= 4, prog: (x) => [Math.min(4, x.maxWorkoutsInWeek), 4] },
  { id: 'consistent', ic: 'spark', t: 'Consistent', d: '80%+ check-in consistency across at least 7 check-ins.',
    test: (x) => x.checkinCount >= CONSISTENT_MIN_CHECKINS && x.consistency >= 80,
    prog: (x) => (x.checkinCount < CONSISTENT_MIN_CHECKINS
      ? [x.checkinCount, CONSISTENT_MIN_CHECKINS]
      : [Math.min(80, x.consistency), 80]) },
];

/** Definitions that now pass but aren't unlocked yet. */
export function findNewUnlocks(user, today) {
  const ctx = achievementContext(user, today);
  return ACH_DEFS.filter((a) => !user.unlocked.includes(a.id) && a.test(ctx));
}
