import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, todayStr } from '../../src/domain/dates.js';
import { parseDuration, calcStreak, currentDayIndex, goalProgressPct, homeMotivation, waterMessage, weightDeltaText } from '../../src/domain/journey.js';
import { findNewUnlocks, maxWorkoutsInWeek } from '../../src/domain/achievements.js';
import { dayStatusClass, progressStats } from '../../src/domain/metrics.js';
import { to12, to24 } from '../../src/domain/checkin.js';

test('dates use the local calendar day', () => {
  assert.equal(todayStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-01-01', '2026-01-25'), 24);
});

test('streak counts back from today, or from yesterday if today is not done', () => {
  const c = (...ds) => Object.fromEntries(ds.map((d) => [d, {}]));
  assert.equal(calcStreak(c('2026-05-08', '2026-05-09', '2026-05-10'), '2026-05-10'), 3);
  assert.equal(calcStreak(c('2026-05-08', '2026-05-09'), '2026-05-10'), 2);
  assert.equal(calcStreak(c('2026-05-07', '2026-05-09'), '2026-05-10'), 1);
  assert.equal(calcStreak({}, '2026-05-10'), 0);
});

test('day index is clamped to the journey length', () => {
  const j = { start: '2026-01-01', duration: 30 };
  assert.equal(currentDayIndex(j, '2026-01-01'), 1);
  assert.equal(currentDayIndex(j, '2026-03-01'), 30);
});

test('goal progress, delta and motivation copy', () => {
  const j = { startWeight: 72, goalWeight: 62 };
  assert.equal(goalProgressPct(j, 67), 50);
  assert.equal(goalProgressPct(j, 80), 0);
  assert.equal(goalProgressPct(j, 50), 100);
  assert.equal(weightDeltaText(72, 68.4), '−3.6 kg since starting');
  assert.equal(weightDeltaText(72, 73), '+1.0 kg since starting');
  assert.equal(weightDeltaText(72, 72), 'Just getting started');
  assert.equal(homeMotivation(1, 90, 0, 0), 'Your journey starts today.');
  assert.equal(homeMotivation(10, 90, 8, 10), "You're on a roll.");
  assert.equal(homeMotivation(50, 90, 1, 10), "You're halfway there. Keep going.");
  assert.equal(homeMotivation(10, 90, 1, 90), "You're getting closer.");
});

test('water message tiers', () => {
  assert.equal(waterMessage(0, 2500).text, "Let's get started.");
  assert.equal(waterMessage(1300, 2500).text, "You're halfway there. Keep going.");
  assert.equal(waterMessage(2500, 2500).goalHit, true);
  assert.match(waterMessage(3000, 2500).text, /beyond/);
});

test('12h/24h time conversion round-trips', () => {
  assert.equal(to24('8:30 AM'), '08:30');
  assert.equal(to24('12:05 AM'), '00:05');
  assert.equal(to24('7:15 PM'), '19:15');
  assert.equal(to12('00:05'), '12:05 AM');
  assert.equal(to12('13:00'), '1:00 PM');
});

test('achievements unlock from check-in history', () => {
  const journey = { start: '2026-05-01', duration: 90, startWeight: 72, goalWeight: 62, waterGoal: 2500 };
  const mk = (n) => {
    const checkins = {};
    for (let i = 0; i < n; i++) checkins[addDays('2026-05-01', i)] = { water: 2500, exercise: { type: 'Gym', duration: 30 } };
    return { journey, checkins, unlocked: [] };
  };
  const ids = (u, today) => findNewUnlocks(u, today).map((a) => a.id);
  assert.deepEqual(ids(mk(1), '2026-05-01'), ['first']); // 80% of a single day is not consistency
  assert.ok(ids(mk(7), '2026-05-07').includes('consistent'));
  assert.ok(ids(mk(3), '2026-05-03').includes('d3'));
  assert.ok(!ids(mk(6), '2026-05-06').includes('d7'));
  assert.ok(ids(mk(7), '2026-05-07').includes('d7'));
  assert.ok(ids(mk(7), '2026-05-07').includes('hydrated'));
  assert.ok(ids(mk(4), '2026-05-04').includes('active'));
  assert.equal(maxWorkoutsInWeek(mk(10).checkins), 7);
  const done = mk(7);
  done.unlocked = ['first', 'd3', 'd7'];
  assert.ok(!ids(done, '2026-05-07').includes('d7'));
});

test('calendar cell status and progress stats', () => {
  assert.equal(dayStatusClass(null, true, 2500), 'future');
  assert.equal(dayStatusClass(null, false, 2500), 'm');
  assert.equal(dayStatusClass({ weight: 70, water: 2000, exercise: { type: 'x', duration: 1 } }, false, 2500), 'c'); // 80% of goal
  assert.equal(dayStatusClass({ weight: 70, water: 1999, exercise: { type: 'x', duration: 1 } }, false, 2500), 'p');
  assert.equal(dayStatusClass({ weight: 70, water: 2500, exercise: null }, false, 2500), 'p');
  const user = {
    journey: { start: '2026-05-01', duration: 90, startWeight: 72, goalWeight: 62 },
    checkins: {
      '2026-05-01': { weight: 72, water: 2000, exercise: null },
      '2026-05-02': { weight: 71, water: 3000, exercise: { type: 'Gym', duration: 30 } },
    },
  };
  const s = progressStats(user, 7, '2026-05-02');
  assert.equal(s.now, 71);
  assert.equal(s.change, -1);
  assert.equal(s.checkinCount, 2);
  assert.equal(s.workouts, 1);
  assert.equal(s.avgWaterMl, 2500);
  assert.equal(s.checkinDenominator, 7); // the window the user asked for
  assert.equal(s.window.elapsed, 2); // ...but only 2 days of it exist
});

// ---------- empty account (real new user: nothing logged yet) ----------
import { lastLoggedWeight, latestWeight } from '../../src/domain/journey.js';
import { chartPoints, shareStats } from '../../src/domain/metrics.js';
import { ACH_DEFS } from '../../src/domain/achievements.js';

const NEW_USER = {
  journey: { start: '2026-09-26', duration: 30, startWeight: 70, goalWeight: 62, waterGoal: 2500 },
  checkins: {}, unlocked: [], unlockedDates: {},
};

test('new user: nothing is invented — no weight history, streak, chart points or achievements', () => {
  assert.equal(lastLoggedWeight(NEW_USER), null);
  assert.equal(latestWeight(NEW_USER), 70); // only the onboarding starting weight
  const s = progressStats(NEW_USER, 30, '2026-09-26');
  assert.equal(s.streak, 0);
  assert.equal(s.checkinCount, 0);
  assert.equal(s.workouts, 0);
  assert.equal(s.avgWaterMl, null);
  assert.deepEqual(chartPoints(NEW_USER, s.inRange), []);
  assert.equal(shareStats(NEW_USER, '2026-09-26').workouts, 0);
  assert.deepEqual(findNewUnlocks(NEW_USER, '2026-09-26'), []);
  assert.equal(ACH_DEFS.every((a) => a.prog({ checkinCount: 0, streak: 0, bestStreak: 0, hydratedDays: 0, maxWorkoutsInWeek: 0, consistency: 0 })[0] === 0), true);
});

test('a check-in without a typed weight does not create a weight point', () => {
  const u = { ...NEW_USER, checkins: { '2026-09-26': { mood: null, weight: null, water: 500, meals: {}, exercise: null, notes: '' } } };
  assert.equal(lastLoggedWeight(u), null);
  assert.deepEqual(chartPoints(u, ['2026-09-26']), []);
});

test('custom journey duration validation (7..365, whole numbers only)', () => {
  for (const [raw, v] of [['30', 30], ['60', 60], ['90', 90], ['7', 7], ['45', 45], ['120', 120], ['365', 365], [' 45 ', 45], [45, 45]]) {
    assert.deepEqual(parseDuration(raw), { ok: true, value: v }, String(raw));
  }
  assert.equal(parseDuration('6').error, 'Choose at least 7 days.');
  assert.equal(parseDuration('0').error, 'Choose at least 7 days.');
  assert.equal(parseDuration('366').error, 'Your journey can be up to 365 days.');
  for (const bad of ['', '   ', null, undefined, '4.5', '45.0', '-10', 'abc', '4x', '1e2', '+45']) {
    assert.equal(parseDuration(bad).ok, false, String(bad));
  }
});

test('day index and progress follow a custom duration', () => {
  const j = { start: '2026-01-01', duration: 45 };
  assert.equal(currentDayIndex(j, '2026-01-01'), 1);
  assert.equal(currentDayIndex(j, '2026-06-01'), 45);
  assert.equal(homeMotivation(23, 45, 0, 10), "You're halfway there. Keep going.");
});
