// Goal achievement (pure). The app never judges whether a goal is desirable: it recognises that the user reached
// the target THEY entered, in whichever direction (gain or loss), and keeps the journey going afterwards.
//
// The journey itself is never ended or replaced: the original goal is recorded as achieved on day N, and the days
// after it are the "next chapter", governed by a post-goal mode:
//   new_goal  keep going toward another weight (journey.nextGoal)
//   maintain  hold the achieved weight
//   journal   no weight target, just the daily journal
//   null      not chosen yet (the Home screen keeps offering the choice)
import { daysBetween } from './dates.js';

export const POST_GOAL_MODES = ['new_goal', 'maintain', 'journal'];
export const MIN_WEIGHT = 30;
export const MAX_WEIGHT = 300;

export function goalDirection(journey) {
  if (journey.goalWeight > journey.startWeight) return 'gain';
  if (journey.goalWeight < journey.startWeight) return 'loss';
  return 'none';
}

export function hasReached(direction, weight, goal) {
  if (direction === 'gain') return weight >= goal;
  if (direction === 'loss') return weight <= goal;
  return false;
}

/** Share of the from->to distance covered by `weight`, clamped 0..100. Works for both gaining and losing. */
export function progressToward(from, to, weight) {
  const total = to - from;
  return total === 0 ? 0 : Math.max(0, Math.min(100, ((weight - from) / total) * 100));
}

/** First check-in date (inside the journey) whose logged weight reached the goal, or null. */
export function firstReachedDate(user) {
  const j = user.journey;
  const dir = goalDirection(j);
  if (dir === 'none') return null;
  const dates = Object.keys(user.checkins).sort();
  return dates.find((d) => d >= j.start && user.checkins[d].weight && hasReached(dir, user.checkins[d].weight, j.goalWeight)) || null;
}

/**
 * The facts of the achievement, or null if the goal has not been reached. Once persisted, the recorded unlock date is
 * the source of truth (editing a later weight must never un-achieve the goal).
 */
export function goalAchievement(user) {
  const j = user.journey;
  if (!j) return null;
  const date = (user.unlockedDates && user.unlockedDates.goal) || firstReachedDate(user);
  if (!date) return null;
  const logged = user.checkins[date];
  const weight = logged && logged.weight ? logged.weight : j.goalWeight;
  const day = Math.max(1, daysBetween(j.start, date) + 1);
  return {
    date,
    day,
    weight,
    startWeight: j.startWeight,
    goalWeight: j.goalWeight,
    duration: j.duration,
    direction: goalDirection(j),
    daysEarly: Math.max(0, j.duration - day),
    change: weight - j.startWeight,
    journeyPct: Math.min(100, Math.round((day / j.duration) * 100)),
  };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** All the words the celebration, Home card, trophy and profile badge use, in one place. */
export function goalCopy(a) {
  const early = a.daysEarly > 0;
  return {
    weight: `${a.weight.toFixed(1)} kg`,
    range: `${a.startWeight.toFixed(1)} → ${a.weight.toFixed(1)}`,
    change: `${a.change >= 0 ? '+' : '−'}${Math.abs(a.change).toFixed(1)} kg`,
    dayText: plural(a.day, 'day'),
    earlyBadge: early ? `${plural(a.daysEarly, 'day').toUpperCase()} EARLY` : 'RIGHT ON TIME',
    earlyLine: early ? `${plural(a.daysEarly, 'day')} ahead of schedule` : 'Reached within your journey',
    reachedLine: `Goal reached on Day ${a.day}`,
    trophyLine: early
      ? `${plural(a.daysEarly, 'day')} ahead of your original ${a.duration}-day journey`
      : `Within your original ${a.duration}-day journey`,
    journeyLine: `${a.journeyPct}% of your journey completed`,
    badge: `Day ${a.day} · ${a.weight.toFixed(1).replace(/\.0$/, '')} kg`,
    remaining: a.duration - a.day,
  };
}

export function postGoalSummary(journey) {
  switch (journey.postGoalMode) {
    case 'new_goal': return `New goal: ${journey.nextGoal} kg`;
    case 'maintain': return `Maintaining ${journey.goalWeight} kg`;
    case 'journal': return 'Journaling without a weight goal';
    default: return null;
  }
}

/** What the Home progress bar tracks: the new goal once one is chosen, otherwise the original goal. */
export function activeTarget(journey) {
  if (journey.postGoalMode === 'new_goal' && journey.nextGoal) {
    return { from: journey.goalWeight, to: journey.nextGoal, label: 'New goal' };
  }
  return { from: journey.startWeight, to: journey.goalWeight, label: 'Goal' };
}

/** Validates the new goal typed after achieving the first one. Returns { ok, value } | { ok:false, error }. */
export function parseNextGoal(raw, journey) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (s === '') return { ok: false, error: 'Enter your new goal weight.' };
  if (!/^\d+(\.\d)?$/.test(s)) return { ok: false, error: 'Use a number, like 68 or 68.5.' };
  const n = Number(s);
  if (n < MIN_WEIGHT || n > MAX_WEIGHT) return { ok: false, error: `Choose a weight between ${MIN_WEIGHT} and ${MAX_WEIGHT} kg.` };
  if (n === journey.goalWeight) return { ok: false, error: 'That is the goal you just reached. Choose "Maintain" to hold it.' };
  return { ok: true, value: n };
}
