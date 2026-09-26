// Journey Complete (pure). Two separate questions: did she reach her weight goal, and did she finish the journey?
//
// A journey is COMPLETE once its last day (start + duration - 1) has arrived, whether or not the goal was reached.
// The recap never says "failed": a goal that wasn't reached is reported as what remains, next to what she built.
// A completed journey is immutable history. "What's next" always starts a NEW journey (see startNextJourney in the
// repository); it never extends or edits the finished one.
import { addDays, daysBetween } from './dates.js';
import { computeStreak } from './streak.js';
import { goalDate, MAX_JOURNEY_DAYS, MIN_JOURNEY_DAYS, parseDuration } from './journey.js';
import { goalDirection, hasReached, parseNextGoal } from './goal.js';

export const isJourneyEnded = (journey, today) => today >= goalDate(journey);

/** Check-in dates that belong to this journey: from its start to its last day, never after (immutable). */
export function journeyDates(user, journey = user.journey) {
  const end = goalDate(journey);
  return Object.keys(user.checkins).filter((d) => d >= journey.start && d <= end).sort();
}

/**
 * Everything the recap shows, from real check-ins inside the journey window only.
 * `goalStatus`: 'reached' | 'not_reached'. `sameDay` marks a goal reached on the journey's final day.
 */
export function journeyRecap(user, journey = user.journey) {
  const dates = journeyDates(user, journey);
  const logged = dates.filter((d) => user.checkins[d].weight);
  const finalWeight = logged.length ? user.checkins[logged[logged.length - 1]].weight : journey.startWeight;
  const dir = goalDirection(journey);
  const reachedOn = dir === 'none' ? null : logged.find((d) => hasReached(dir, user.checkins[d].weight, journey.goalWeight)) || null;
  const reachedDay = reachedOn ? daysBetween(journey.start, reachedOn) + 1 : null;
  const checkins = dates.map((d) => user.checkins[d]);
  const goalMl = journey.waterGoal;
  const streakOf = computeStreak(Object.fromEntries(dates.map((d) => [d, user.checkins[d]])), goalDate(journey));
  return {
    start: journey.start,
    end: goalDate(journey),
    duration: journey.duration,
    startWeight: journey.startWeight,
    goalWeight: journey.goalWeight,
    finalWeight,
    direction: dir,
    hasWeightGoal: dir !== 'none',
    goalStatus: reachedOn ? 'reached' : 'not_reached',
    reachedOn,
    reachedDay,
    sameDay: reachedDay === journey.duration,
    remaining: reachedOn ? 0 : Math.abs(journey.goalWeight - finalWeight),
    change: finalWeight - journey.startWeight,
    checkins: dates.length,
    weighIns: logged.length,
    bestStreak: streakOf.best,
    hydrationDays: checkins.filter((c) => (c.water || 0) >= goalMl).length,
    movementDays: checkins.filter((c) => c.exercise).length,
    completionPct: Math.round((dates.length / journey.duration) * 100),
    notes: dates.filter((d) => (user.checkins[d].notes || '').trim()).map((d) => ({ date: d, text: user.checkins[d].notes.trim() })),
  };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const kg = (n) => `${Number(n).toFixed(1).replace(/\.0$/, '')} kg`;

/** All the words of the recap, in one place. Deliberately has no "fail" wording anywhere. */
export function recapCopy(r) {
  let headline; let lines;
  if (r.goalStatus === 'reached' && r.sameDay) {
    headline = 'GOAL ACHIEVED. JOURNEY COMPLETE.';
    lines = [`You reached ${kg(r.goalWeight)} on the final day of your ${r.duration}-day journey.`];
  } else if (r.goalStatus === 'reached') {
    headline = `${r.duration} DAYS. COMPLETED.`;
    lines = [
      `You started at ${kg(r.startWeight)}. Your goal was ${kg(r.goalWeight)}.`,
      `You reached your goal on Day ${r.reachedDay}.`,
      `You continued your journey for another ${plural(r.duration - r.reachedDay, 'day')}.`,
    ];
  } else if (!r.hasWeightGoal) {
    headline = `${r.duration} DAYS COMPLETED`;
    lines = ['You showed up for your journey.'];
  } else {
    const strong = r.checkins / r.duration >= 0.75;
    headline = strong ? `${r.duration} DAYS. YOU SHOWED UP.` : `${r.duration} DAYS COMPLETED`;
    lines = strong
      ? ["You didn't reach your original target yet.", 'But look what you built.']
      : [
        'You showed up for your journey.',
        `${kg(r.finalWeight)} · Goal: ${kg(r.goalWeight)} · ${kg(r.remaining)} remaining`,
        "Your goal wasn't reached within this journey, but your journey still counts.",
      ];
  }
  const stats = [
    [String(r.checkins), r.checkins === 1 ? 'check-in' : 'check-ins'],
    [String(r.bestStreak), 'day best streak'],
    [String(r.hydrationDays), 'hydration goals hit'],
    [String(r.movementDays), 'movement days'],
    [`${r.completionPct}%`, 'of days recorded'],
  ];
  return { headline, lines, stats, closing: 'Your next chapter is yours to choose.' };
}

/** The journey achievement's unlock rule: the last day has arrived. (Shown once; the recap stays on Home.) */
export const JOURNEY_ACHIEVEMENT = 'journey';

// ---------------------------------------------------------------- what's next
export const CHAPTER_KINDS = ['continue', 'new_goal', 'maintain', 'journal'];

/** Which "What's next" options apply. "Continue toward your goal" only exists if the goal wasn't reached. */
export function chapterOptions(r) {
  const opts = [];
  if (r.hasWeightGoal && r.goalStatus !== 'reached') {
    opts.push({ kind: 'continue', title: 'Continue toward your goal', sub: `Keep working toward ${kg(r.goalWeight)} in a new journey.` });
  }
  opts.push({ kind: 'new_goal', title: 'Set a new goal', sub: 'Choose a new target weight for your next journey.' });
  if (r.goalStatus === 'reached') {
    opts.push({ kind: 'maintain', title: 'Maintain my progress', sub: `Hold ${kg(r.finalWeight)} and keep your healthy habits.` });
  }
  opts.push({ kind: 'journal', title: 'Continue without a weight goal', sub: 'Journal hydration, meals, movement, mood and habits.' });
  return opts;
}

/**
 * Validates the next-chapter form and returns the new journey, or { ok:false, error }.
 * Journey N+1 starts the day after the previous one ends (or today, if she is late), from the weight she finished at.
 */
export function buildNextJourney(prev, recap, { kind, goal = '', duration = prev.duration }, today) {
  if (!CHAPTER_KINDS.includes(kind)) return { ok: false, error: 'Choose how you would like to continue.' };
  const d = parseDuration(duration);
  if (!d.ok) return { ok: false, error: d.error };
  let goalWeight = recap.finalWeight;
  let postGoalMode = null;
  if (kind === 'continue') goalWeight = prev.goalWeight;
  else if (kind === 'new_goal') {
    const g = parseNextGoal(goal, { goalWeight: recap.finalWeight });
    if (!g.ok) return { ok: false, error: g.error.replace('the goal you just reached', 'your current weight').replace('"Maintain" to hold it', '"Maintain" to hold your weight') };
    goalWeight = g.value;
  } else postGoalMode = kind; // 'maintain' | 'journal'
  const nextStart = addDays(goalDate(prev), 1);
  return {
    ok: true,
    journey: {
      start: nextStart > today ? nextStart : today,
      duration: d.value,
      startWeight: recap.finalWeight,
      goalWeight,
      waterGoal: prev.waterGoal,
      postGoalMode,
      nextGoal: null,
    },
  };
}

export { MAX_JOURNEY_DAYS, MIN_JOURNEY_DAYS };
