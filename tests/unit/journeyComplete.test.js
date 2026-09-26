// Journey Complete: completion is independent of goal status, the recap never says "failed", and "what's next"
// builds a NEW journey (the finished one is immutable history).
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../../src/domain/dates.js';
import { ACH_DEFS, findNewUnlocks } from '../../src/domain/achievements.js';
import {
  buildNextJourney, chapterOptions, isJourneyEnded, journeyDates, journeyRecap, recapCopy,
} from '../../src/domain/journeyComplete.js';
import { nextJourneyToRpcArgs, rowsToAchievements, splitJourneys } from '../../src/data/mappers.js';

const START = '2026-09-01';
const day = (n) => addDays(START, n - 1);
const journey = (over = {}) => ({ start: START, duration: 60, startWeight: 48, goalWeight: 65, waterGoal: 2500, postGoalMode: null, nextGoal: null, completedOn: null, ...over });
const ci = (weight, extra = {}) => ({ weight, water: 0, meals: {}, exercise: null, notes: '', ...extra });
const userWith = (entries, j = journey()) => ({
  journey: j, unlocked: [], unlockedDates: {}, checkins: Object.fromEntries(Object.entries(entries).map(([n, c]) => [day(Number(n)), c])),
});

test('a journey is complete once its last day (start + duration - 1) arrives', () => {
  assert.equal(isJourneyEnded(journey(), day(59)), false);
  assert.equal(isJourneyEnded(journey(), day(60)), true);
  assert.equal(isJourneyEnded(journey(), day(75)), true);
});

test('recap only counts check-ins inside the journey window (later days belong to the next journey)', () => {
  const u = userWith({ 1: ci(48), 30: ci(65), 60: ci(66), 61: ci(70) });
  assert.equal(journeyDates(u).length, 3);
  assert.equal(journeyRecap(u).finalWeight, 66);
});

test('goal reached early: recap tells both stories', () => {
  const u = userWith({ 1: ci(48), 30: ci(65), 60: ci(66) });
  const r = journeyRecap(u);
  assert.equal(r.goalStatus, 'reached');
  assert.equal(r.reachedDay, 30);
  assert.equal(r.sameDay, false);
  const c = recapCopy(r);
  assert.equal(c.headline, '60 DAYS. COMPLETED.');
  assert.match(c.lines.join(' '), /reached your goal on Day 30/);
  assert.match(c.lines.join(' '), /another 30 days/);
});

test('goal reached on the final day combines both milestones', () => {
  const r = journeyRecap(userWith({ 1: ci(48), 60: ci(65) }));
  assert.equal(r.sameDay, true);
  const c = recapCopy(r);
  assert.equal(c.headline, 'GOAL ACHIEVED. JOURNEY COMPLETE.');
  assert.match(c.lines[0], /final day of your 60-day journey/);
});

test('goal not reached: honest numbers, encouraging words, never "fail"', () => {
  const u = userWith({ 1: ci(80), 60: ci(71) }, journey({ startWeight: 80, goalWeight: 65 }));
  const r = journeyRecap(u);
  assert.equal(r.goalStatus, 'not_reached');
  assert.equal(r.remaining, 6);
  const c = recapCopy(r);
  const text = [c.headline, ...c.lines, c.closing].join(' ');
  assert.match(text, /71 kg/);
  assert.match(text, /6 kg remaining/);
  assert.match(text, /journey still counts/);
  assert.doesNotMatch(text, /fail|unsuccessful|missed/i);
});

test('strong journey that fell short says "you showed up" and lists what she built', () => {
  const entries = Object.fromEntries(Array.from({ length: 52 }, (_, i) => [i + 1, ci(i === 51 ? 67 : 72, {
    water: 2500, exercise: i < 45 ? { type: 'Walk', duration: 30, unit: 'minutes' } : null,
  })]));
  const r = journeyRecap(userWith(entries, journey({ startWeight: 75 })));
  assert.equal(r.goalStatus, 'not_reached');
  assert.equal(r.checkins, 52);
  assert.equal(r.movementDays, 45);
  assert.equal(r.hydrationDays, 52);
  assert.equal(r.bestStreak, 52);
  const c = recapCopy(r);
  assert.equal(c.headline, '60 DAYS. YOU SHOWED UP.');
  assert.match(c.lines.join(' '), /look what you built/i);
  assert.equal(c.stats.find(([, l]) => l === 'movement days')[0], '45');
});

test("what's next: \"continue\" only when the goal was not reached; \"maintain\" only when it was", () => {
  const missed = chapterOptions(journeyRecap(userWith({ 1: ci(48), 60: ci(60) })));
  assert.deepEqual(missed.map((o) => o.kind), ['continue', 'new_goal', 'journal']);
  const hit = chapterOptions(journeyRecap(userWith({ 1: ci(48), 30: ci(65) })));
  assert.deepEqual(hit.map((o) => o.kind), ['new_goal', 'maintain', 'journal']);
});

test('next journey: starts the day after the last day, from the final weight, journey 1 untouched', () => {
  const prev = journey();
  const recap = journeyRecap(userWith({ 1: ci(48), 30: ci(65), 60: ci(65) }));
  const snapshot = JSON.stringify(prev);
  const n = buildNextJourney(prev, recap, { kind: 'new_goal', goal: '62', duration: '90' }, day(60));
  assert.equal(n.ok, true);
  assert.deepEqual([n.journey.start, n.journey.startWeight, n.journey.goalWeight, n.journey.duration], [day(61), 65, 62, 90]);
  assert.equal(JSON.stringify(prev), snapshot); // immutable
  const late = buildNextJourney(prev, recap, { kind: 'new_goal', goal: '62', duration: '90' }, day(70));
  assert.equal(late.journey.start, day(70)); // a late visitor starts today, not in the past
  const keep = buildNextJourney(prev, recap, { kind: 'maintain', duration: '30' }, day(61));
  assert.deepEqual([keep.journey.goalWeight, keep.journey.postGoalMode], [65, 'maintain']);
  const jr = buildNextJourney(prev, recap, { kind: 'journal', duration: '30' }, day(61));
  assert.equal(jr.journey.postGoalMode, 'journal');
  const cont = buildNextJourney(prev, journeyRecap(userWith({ 1: ci(48), 60: ci(60) })), { kind: 'continue', duration: '60' }, day(61));
  assert.deepEqual([cont.journey.startWeight, cont.journey.goalWeight], [60, 65]);
});

test('next journey validation: bad kind, length and goal are rejected with a message', () => {
  const prev = journey();
  const recap = journeyRecap(userWith({ 1: ci(48), 60: ci(65) }));
  assert.equal(buildNextJourney(prev, recap, { kind: 'x', duration: '30' }, day(61)).ok, false);
  assert.equal(buildNextJourney(prev, recap, { kind: 'journal', duration: '3' }, day(61)).ok, false);
  assert.equal(buildNextJourney(prev, recap, { kind: 'new_goal', goal: '', duration: '30' }, day(61)).ok, false);
  assert.match(buildNextJourney(prev, recap, { kind: 'new_goal', goal: '65', duration: '30' }, day(61)).error, /current weight/);
});

test('journey achievement is manual: never produced by findNewUnlocks, but its rule matches completion', () => {
  const u = userWith({ 1: ci(48), 60: ci(50) });
  assert.equal(findNewUnlocks(u, day(60)).some((a) => a.id === 'journey'), false);
  const def = ACH_DEFS.find((a) => a.id === 'journey');
  assert.equal(def.manual, true);
  assert.equal(def.test({ journeyEnded: true }), true);
  assert.equal(def.test({ journeyEnded: false }), false);
});

test('data mapping: active vs completed journeys, scoped achievements, RPC args', () => {
  const row = (start, over = {}) => ({ start_date: start, duration_days: 60, start_weight: '48', goal_weight: '65', water_goal_ml: 2500, completed_on: null, ...over });
  const { journey: active, past } = splitJourneys([row('2026-11-01'), row('2026-09-01', { completed_on: '2026-10-30' })]);
  assert.equal(active.start, '2026-11-01');
  assert.equal(past.length, 1);
  assert.equal(past[0].completedOn, '2026-10-30');
  const ach = [
    { achievement_id: 'goal', unlocked_on: '2026-09-20' },
    { achievement_id: 'journey', unlocked_on: '2026-10-30' },
    { achievement_id: 'd3', unlocked_on: '2026-09-04' },
  ];
  assert.deepEqual(rowsToAchievements(ach, active).unlocked, ['d3']); // journey 1's goal/journey are history for journey 2
  assert.deepEqual(rowsToAchievements(ach, past[0]).unlocked, ['goal', 'journey', 'd3']);
  assert.equal(nextJourneyToRpcArgs(journey(), 'maintain').p_mode, 'maintain');
});
