// Goal Achievement: detection (gain and loss), copy, post-goal modes, the phase state machine, achievement wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../../src/domain/dates.js';
import {
  activeTarget, firstReachedDate, goalAchievement, goalCopy, goalDirection, hasReached, parseNextGoal, postGoalSummary, progressToward,
} from '../../src/domain/goal.js';
import { goalProgressPct } from '../../src/domain/journey.js';
import { ACH_DEFS, findNewUnlocks } from '../../src/domain/achievements.js';
import { createSequence, phasesFor } from '../../src/domain/goalSequence.js';
import { postGoalToRow, rowToJourney } from '../../src/data/mappers.js';

const START = '2026-09-01';
const journey = (over = {}) => ({ start: START, duration: 60, startWeight: 48, goalWeight: 65, waterGoal: 2500, postGoalMode: null, nextGoal: null, ...over });
const day = (n) => addDays(START, n - 1);
const userWith = (weights, j = journey(), extra = {}) => ({
  journey: j, unlocked: [], unlockedDates: {}, ...extra,
  checkins: Object.fromEntries(Object.entries(weights).map(([n, w]) => [day(Number(n)), { weight: w, water: 0, meals: {}, exercise: null, notes: '' }])),
});

test('direction and reaching: gain goals need >=, loss goals need <=, equal start/goal is never reached', () => {
  assert.equal(goalDirection(journey()), 'gain');
  assert.equal(goalDirection(journey({ startWeight: 80, goalWeight: 70 })), 'loss');
  assert.equal(goalDirection(journey({ startWeight: 70, goalWeight: 70 })), 'none');
  assert.equal(hasReached('gain', 65, 65), true);
  assert.equal(hasReached('gain', 64.9, 65), false);
  assert.equal(hasReached('loss', 70, 70), true);
  assert.equal(hasReached('loss', 70.1, 70), false);
  assert.equal(hasReached('none', 70, 70), false);
});

test('progress is direction-aware: a 48 -> 65 gain is not stuck at 0%', () => {
  assert.equal(Math.round(goalProgressPct(journey(), 56.5)), 50);
  assert.equal(goalProgressPct(journey(), 65), 100);
  assert.equal(goalProgressPct(journey(), 70), 100); // clamped
  assert.equal(goalProgressPct(journey(), 40), 0);
  assert.equal(Math.round(goalProgressPct(journey({ startWeight: 80, goalWeight: 70 }), 75)), 50); // loss still works
  assert.equal(progressToward(5, 5, 5), 0);
});

test('the example: 60-day journey, 48 -> 65 kg, reached on Day 30', () => {
  const u = userWith({ 1: 48, 15: 56, 29: 64.2, 30: 65 });
  assert.equal(firstReachedDate(u), day(30));
  const a = goalAchievement(u);
  assert.deepEqual({ day: a.day, daysEarly: a.daysEarly, change: a.change, journeyPct: a.journeyPct, weight: a.weight }, { day: 30, daysEarly: 30, change: 17, journeyPct: 50, weight: 65 });
  const c = goalCopy(a);
  assert.equal(c.weight, '65.0 kg');
  assert.equal(c.range, '48.0 → 65.0');
  assert.equal(c.change, '+17.0 kg');
  assert.equal(c.earlyBadge, '30 DAYS EARLY');
  assert.equal(c.reachedLine, 'Goal reached on Day 30');
  assert.equal(c.trophyLine, '30 days ahead of your original 60-day journey');
  assert.equal(c.journeyLine, '50% of your journey completed');
  assert.equal(c.badge, 'Day 30 · 65 kg');
  assert.equal(c.remaining, 30);
});

test('not reached -> null; the first reaching day wins; overshoot is still the goal day', () => {
  assert.equal(goalAchievement(userWith({ 1: 48, 29: 64.9 })), null);
  const u = userWith({ 10: 66, 20: 70 });
  assert.equal(goalAchievement(u).day, 10);
  assert.equal(goalAchievement(u).weight, 66);
});

test('loss goals are celebrated the same way; the copy signs the change', () => {
  const a = goalAchievement(userWith({ 20: 69.5 }, journey({ startWeight: 80, goalWeight: 70 })));
  assert.equal(goalCopy(a).change, '−10.5 kg');
  assert.equal(a.direction, 'loss');
});

test('reached on the final day or after the journey ended: no days early, never negative', () => {
  const last = goalCopy(goalAchievement(userWith({ 60: 65 })));
  assert.equal(last.earlyBadge, 'RIGHT ON TIME');
  assert.equal(last.trophyLine, 'Within your original 60-day journey');
  const late = goalAchievement(userWith({ 75: 65 }));
  assert.equal(late.daysEarly, 0);
  assert.equal(late.journeyPct, 100);
  assert.equal(goalCopy(goalAchievement(userWith({ 59: 65 }))).earlyBadge, '1 DAY EARLY');
});

test('check-ins before the journey start never count', () => {
  const u = userWith({});
  u.checkins[addDays(START, -3)] = { weight: 70, water: 0, meals: {}, exercise: null, notes: '' };
  assert.equal(goalAchievement(u), null);
});

test('once recorded, the unlock date is the source of truth: a later edit cannot un-achieve the goal', () => {
  const u = userWith({ 30: 64 }, journey(), { unlocked: ['goal'], unlockedDates: { goal: day(30) } });
  const a = goalAchievement(u);
  assert.equal(a.day, 30);
  assert.equal(a.weight, 64); // what is logged that day now; the goal day itself stays fixed
});

test('the goal achievement unlocks only through reaching the goal, only once, and is special', () => {
  const def = ACH_DEFS.find((d) => d.id === 'goal');
  assert.equal(def.special, true);
  const ids = (u) => findNewUnlocks(u, day(30)).map((d) => d.id);
  assert.equal(ids(userWith({ 29: 64 })).includes('goal'), false);
  assert.equal(ids(userWith({ 30: 65 })).includes('goal'), true);
  assert.equal(ids(userWith({ 30: 65 }, journey(), { unlocked: ['goal'] })).includes('goal'), false);
  // 30 check-ins, a streak, hydration... none of them can unlock it without the weight
  const busy = userWith(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, 50])));
  assert.equal(ids(busy).includes('goal'), false);
});

test('post-goal modes: summary, active target, new-goal validation', () => {
  assert.equal(postGoalSummary(journey()), null);
  assert.equal(postGoalSummary(journey({ postGoalMode: 'new_goal', nextGoal: 68 })), 'New goal: 68 kg');
  assert.equal(postGoalSummary(journey({ postGoalMode: 'maintain' })), 'Maintaining 65 kg');
  assert.equal(postGoalSummary(journey({ postGoalMode: 'journal' })), 'Journaling without a weight goal');
  assert.deepEqual(activeTarget(journey()), { from: 48, to: 65, label: 'Goal' });
  assert.deepEqual(activeTarget(journey({ postGoalMode: 'new_goal', nextGoal: 68 })), { from: 65, to: 68, label: 'New goal' });
  assert.deepEqual(activeTarget(journey({ postGoalMode: 'maintain' })), { from: 48, to: 65, label: 'Goal' });
  const j = journey();
  assert.deepEqual(parseNextGoal('68', j), { ok: true, value: 68 });
  assert.deepEqual(parseNextGoal('68,5', j), { ok: true, value: 68.5 });
  ['', 'abc', '68.55', '-3', '29', '301'].forEach((bad) => assert.equal(parseNextGoal(bad, j).ok, false, bad));
  assert.equal(parseNextGoal('65', j).ok, false); // that is "maintain"
});

test('mappers: post-goal columns round-trip; only new_goal keeps a weight', () => {
  assert.deepEqual(postGoalToRow('new_goal', 68), { post_goal_mode: 'new_goal', next_goal_weight: 68 });
  assert.deepEqual(postGoalToRow('maintain', 68), { post_goal_mode: 'maintain', next_goal_weight: null });
  const row = { start_date: START, duration_days: 60, start_weight: '48.0', goal_weight: '65.0', water_goal_ml: 2500 };
  assert.equal(rowToJourney(row).postGoalMode, null);
  assert.equal(rowToJourney(row).nextGoal, null);
  const j = rowToJourney({ ...row, post_goal_mode: 'new_goal', next_goal_weight: '68.0' });
  assert.deepEqual([j.postGoalMode, j.nextGoal], ['new_goal', 68]);
});

test('sequence: first time ends in choices; replay ends at the trophy; skip jumps to the last phase', () => {
  assert.deepEqual(phasesFor({ replay: false }), ['recognition', 'recap', 'trophy', 'choices']);
  assert.deepEqual(phasesFor({ replay: true }), ['recognition', 'recap', 'trophy']);
  const s = createSequence(phasesFor({ replay: false }));
  assert.equal(s.phase, 'recognition');
  assert.equal(s.advance(), 'recap');
  assert.equal(s.skip(), 'choices');
  assert.equal(s.last, true);
  assert.equal(s.finished, false);
  s.advance();
  assert.equal(s.finished, true);
  assert.equal(s.advance(), 'choices'); // finished stays finished
  const r = createSequence(phasesFor({ replay: true }));
  r.advance(); r.advance();
  assert.equal(r.phase, 'trophy');
  assert.equal(r.last, true);
});
