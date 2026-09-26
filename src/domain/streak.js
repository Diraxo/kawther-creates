// Streak model (pure, deterministic — every function takes `today` explicitly).
//
// THE RULES (used identically by Home, Progress, Share, achievements and the completion sheet):
//   * A "check-in day" is a local calendar day (YYYY-MM-DD) that has a saved check-in. Days after `today` are ignored.
//   * A RUN is a maximal sequence of consecutive check-in days.
//   * ACTIVE streak = the length of the run that contains today, or — if today isn't checked in yet — the run that
//     ends yesterday (today is still open, so the streak is alive: status 'pending').
//   * If the most recent check-in is 2+ days ago the streak is INTERRUPTED. It is NOT rewritten to "0 days as if the
//     earlier check-ins never happened": `interruptedLength` keeps the run that was earned and `best` keeps the
//     longest run ever. `current` is 0 while interrupted; missing several days changes nothing further (there is no
//     per-day decrement).
//   * Returning after a gap and checking in starts a NEW run at 1 (status 'active'); `best` is preserved.
//   * Nothing is stored: the model is derived from the check-in dates, so re-computing can never double-count.
import { addDays } from './dates.js';

/**
 * @param {Record<string, unknown> | string[]} checkins check-ins keyed by date, or a list of dates
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ status: 'none'|'active'|'pending'|'interrupted', current: number, best: number,
 *             interruptedLength: number, lastCheckin: string|null }}
 */
export function computeStreak(checkins, today) {
  const dates = [...new Set(Array.isArray(checkins) ? checkins : Object.keys(checkins))].filter((d) => d <= today).sort();
  if (!dates.length) return { status: 'none', current: 0, best: 0, interruptedLength: 0, lastCheckin: null };
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  const lastCheckin = prev;
  const lastRun = run; // the run that ends at the most recent check-in
  if (lastCheckin === today) return { status: 'active', current: lastRun, best, interruptedLength: 0, lastCheckin };
  if (lastCheckin === addDays(today, -1)) return { status: 'pending', current: lastRun, best, interruptedLength: 0, lastCheckin };
  return { status: 'interrupted', current: 0, best, interruptedLength: lastRun, lastCheckin };
}

export const calcStreak = (checkins, today) => computeStreak(checkins, today).current;
