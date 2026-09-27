// Behavioural rules of the final UX pass: streak model, journey dates, durations, progress windows, completion gaps,
// achievements and password policy. All pure functions: deterministic, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, formatDate } from '../../src/domain/dates.js';
import { computeStreak, calcStreak } from '../../src/domain/streak.js';
import { currentDayIndex, goalDate } from '../../src/domain/journey.js';
import {
  checkinGaps, formatLitres, mealCount,
} from '../../src/domain/checkin.js';
import { progressStats, resolveRange, shareStats } from '../../src/domain/metrics.js';
import { ACH_DEFS, achievementContext, findNewUnlocks } from '../../src/domain/achievements.js';
import { validatePasswordChange } from '../../src/domain/password.js';
import { monotonePath, niceTicks } from '../../src/ui/chart-math.js';

const days = (...ds) => Object.fromEntries(ds.map((d) => [d, {}]));
const run = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, i));

// ---------------------------------------------------------------- streak
test('streak: first completed day = 1 day streak (active)', () => {
  const s = computeStreak(days('2026-09-26'), '2026-09-26');
  assert.deepEqual(s, { status: 'active', current: 1, best: 1, interruptedLength: 0, lastCheckin: '2026-09-26' });
});

test("streak: consecutive days increment; an open today keeps yesterday's streak alive", () => {
  assert.equal(computeStreak(days(...run('2026-09-26', 2)), '2026-09-27').current, 2);
  const pending = computeStreak(days(...run('2026-09-26', 2)), '2026-09-28');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.current, 2);
});

test('streak: a missed day interrupts but PRESERVES the earned streak', () => {
  const s = computeStreak(days(...run('2026-09-20', 5)), '2026-09-26'); // last check-in 24th, missed 25th
  assert.equal(s.status, 'interrupted');
  assert.equal(s.current, 0);
  assert.equal(s.interruptedLength, 5);
  assert.equal(s.best, 5);
});

test('streak: multiple missed days stay interrupted, nothing decrements further', () => {
  const ds = days(...run('2026-09-20', 5));
  const a = computeStreak(ds, '2026-09-26');
  const b = computeStreak(ds, '2026-10-30'); // five weeks later
  assert.equal(a.interruptedLength, b.interruptedLength);
  assert.equal(b.status, 'interrupted');
  assert.equal(b.best, 5);
});

test('streak: returning after a gap starts a NEW run at 1; best is kept', () => {
  const ds = days(...run('2026-09-20', 5), '2026-09-27');
  const s = computeStreak(ds, '2026-09-27');
  assert.equal(s.status, 'active');
  assert.equal(s.current, 1);
  assert.equal(s.best, 5);
  assert.equal(s.interruptedLength, 0);
});

test('streak: restoration then consecutive days count up from the new run', () => {
  const ds = days(...run('2026-09-20', 3), '2026-09-27', '2026-09-28');
  assert.equal(computeStreak(ds, '2026-09-28').current, 2);
  assert.equal(computeStreak(ds, '2026-09-28').best, 3);
});

test('streak: deterministic and idempotent, recomputing never double-counts', () => {
  const ds = days(...run('2026-09-24', 3));
  const first = computeStreak(ds, '2026-09-26');
  for (let i = 0; i < 5; i++) assert.deepEqual(computeStreak(ds, '2026-09-26'), first);
  assert.equal(first.current, 3);
  assert.equal(calcStreak(ds, '2026-09-26'), 3);
});

test('streak: no check-ins, and future-dated rows are ignored', () => {
  assert.equal(computeStreak({}, '2026-09-26').status, 'none');
  const s = computeStreak(days('2026-09-26', '2026-09-27'), '2026-09-26'); // tomorrow's row must not count
  assert.equal(s.current, 1);
});

test('streak: month / year / leap-day boundaries are consecutive', () => {
  assert.equal(computeStreak(days('2026-12-30', '2026-12-31', '2027-01-01'), '2027-01-01').current, 3);
  assert.equal(computeStreak(days('2028-02-28', '2028-02-29', '2028-03-01'), '2028-03-01').current, 3);
});

// ---------------------------------------------------------------- journey dates
test('goal date: start date is Day 1, so goal = start + (duration - 1)', () => {
  assert.equal(goalDate({ start: '2026-09-26', duration: 60 }), '2026-11-24');
  assert.equal(goalDate({ start: '2026-09-26', duration: 30 }), '2026-10-25');
  assert.equal(goalDate({ start: '2026-09-26', duration: 45 }), '2026-11-09');
  assert.equal(goalDate({ start: '2026-09-26', duration: 90 }), '2026-12-24');
  assert.equal(goalDate({ start: '2026-09-26', duration: 120 }), '2027-01-23');
  assert.equal(goalDate({ start: '2026-09-26', duration: 7 }), '2026-10-02');
});

test('goal date: month, year and leap-year boundaries; last day index === duration', () => {
  assert.equal(goalDate({ start: '2026-01-31', duration: 30 }), '2026-03-01'); // crosses February (non-leap)
  assert.equal(goalDate({ start: '2028-01-31', duration: 30 }), '2028-02-29'); // leap year
  assert.equal(goalDate({ start: '2026-12-15', duration: 60 }), '2027-02-12'); // year boundary
  assert.equal(goalDate({ start: '2027-02-28', duration: 3 }), '2027-03-02');
  for (const [start, duration] of [['2026-09-26', 60], ['2026-12-31', 45], ['2028-02-01', 365]]) {
    const j = { start, duration };
    assert.equal(currentDayIndex(j, goalDate(j)), duration);
    assert.equal(daysBetween(start, goalDate(j)), duration - 1);
  }
});

test('dates never shift with the local timezone (pure calendar arithmetic)', () => {
  assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // US DST start
  assert.equal(addDays('2026-10-25', 1), '2026-10-26'); // EU DST end
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // US DST end
  assert.match(formatDate('2026-11-24'), /24/);
});

// (movement duration / details are covered in tests/unit/movement.test.js)

// ---------------------------------------------------------------- hydration + completion gaps
test('hydration display uses the user goal, never a hard-coded one', () => {
  assert.equal(`${formatLitres(1500)} / ${formatLitres(5000)}`, '1.5 L / 5 L');
  assert.equal(`${formatLitres(1500)} / ${formatLitres(2500)}`, '1.5 L / 2.5 L');
  assert.equal(`${formatLitres(3000)} / ${formatLitres(5000)}`, '3 L / 5 L');
  assert.equal(formatLitres(2250), '2.25 L');
});

test('completion: reports only applicable incomplete items, never "failed"', () => {
  const empty = { meals: { breakfast: [], lunch: [], dinner: [], snacks: [] } };
  const g = checkinGaps({ ...empty, water: 1500, weight: 63.8, exercise: { type: 'Walking', duration: 30, unit: 'minutes' } }, 5000);
  assert.deepEqual(g.map((x) => [x.id, x.done]), [['water', false], ['move', true], ['meals', false]]);
  assert.match(g[0].text, /1\.5 L \/ 5 L/);
  assert.match(g[0].text, /3\.5 L to go/);
  assert.equal(g[1].text, 'Workout complete: Walking · 30 min');
  assert.equal(g[2].text, 'Meals: Nothing logged yet');
  const done = checkinGaps({ meals: { breakfast: [{ name: 'x' }], lunch: [], dinner: [], snacks: [] }, water: 5000, weight: 60, exercise: null }, 5000);
  assert.deepEqual(done.map((x) => [x.id, x.done]), [['water', true]]); // nothing incomplete, no rest-day nag
  assert.equal(mealCount({ meals: { breakfast: [1, 2], lunch: [3], dinner: [], snacks: [] } }), 3);
});

// ---------------------------------------------------------------- progress windows
const J = { start: '2026-09-26', duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 5000 };
const oneDay = { journey: J, checkins: { '2026-09-26': { weight: 71.5, water: 1500, exercise: { type: 'Gym', duration: 30, unit: 'minutes' }, meals: {} } }, unlocked: [], unlockedDates: {} };

test('progress: 1 day of history, 7/30/90-day views do not pretend to hold 7/30/90 days', () => {
  for (const n of [7, 30, 90]) {
    const s = progressStats(oneDay, { kind: 'days', days: n }, '2026-09-26');
    assert.equal(s.checkinCount, 1);
    assert.equal(s.checkinDenominator, n); // "1 of N days recorded"
    assert.equal(s.window.elapsed, 1);
    assert.equal(s.window.complete, false);
    assert.equal(s.window.journeyDay, 1);
    assert.equal(s.windowChange, null); // one weigh-in cannot show a change
    assert.equal(s.consistency, 100); // of the 1 elapsed day, and the UI says so
  }
});

test('progress: windows are exact (N days ending today), clipped to the journey start', () => {
  const w = resolveRange(J, { kind: 'days', days: 7 }, '2026-10-10');
  assert.equal(w.start, '2026-10-04');
  assert.equal(w.elapsed, 7);
  assert.equal(w.complete, true);
  const early = resolveRange(J, { kind: 'days', days: 30 }, '2026-10-01');
  assert.equal(early.start, '2026-09-26');
  assert.equal(early.elapsed, 6);
  assert.equal(early.days, 30);
  const all = resolveRange(J, { kind: 'all' }, '2026-10-10');
  assert.equal(all.start, '2026-09-26');
  assert.equal(all.days, all.elapsed);
});

test('progress: journey length and range are independent (45/120/365 day journeys, custom ranges)', () => {
  for (const duration of [45, 120, 365]) {
    const u = { ...oneDay, journey: { ...J, duration } };
    const s = progressStats(u, { kind: 'days', days: 60 }, '2026-09-26');
    assert.equal(s.window.days, 60);
    assert.equal(s.window.journeyDay, 1);
  }
  const many = { journey: J, checkins: Object.fromEntries(run('2026-09-26', 20).map((d, i) => [d, { weight: 72 - i * 0.1, water: 2000, exercise: null, meals: {} }])), unlocked: [], unlockedDates: {} };
  const s = progressStats(many, { kind: 'days', days: 10 }, '2026-10-15');
  assert.equal(s.checkinCount, 10);
  assert.equal(s.window.complete, true);
  assert.ok(s.windowChange < 0);
  assert.equal(s.avgWaterMl, 2000);
});

test('progress: an empty account has no averages and no change', () => {
  const s = progressStats({ journey: J, checkins: {}, unlocked: [], unlockedDates: {} }, { kind: 'days', days: 7 }, '2026-09-26');
  assert.equal(s.avgWaterMl, null);
  assert.equal(s.windowChange, null);
  assert.equal(s.consistency, 0);
  assert.equal(s.streakInfo.status, 'none');
});

test('share: only metrics that really exist (null / omitted otherwise)', () => {
  const s = shareStats({ journey: J, checkins: {}, unlocked: [], unlockedDates: {} }, '2026-09-26');
  assert.equal(s.weight, null);
  assert.equal(s.avgWaterL, null);
  assert.equal(s.workouts, 0);
  assert.equal(s.streak, 0);
  const r = shareStats(oneDay, '2026-09-26');
  assert.equal(r.weight, 71.5);
  assert.equal(r.avgWaterL, 1.5);
  assert.equal(r.workouts, 1);
  assert.equal(r.streak, 1);
  assert.equal(r.day, 1);
  assert.equal(r.duration, 60);
});

// ---------------------------------------------------------------- chart math
test('chart: nice ticks cover the data; the monotone curve never overshoots real values', () => {
  const t = niceTicks(61.7, 72.3);
  assert.ok(t[0] <= 61.7 && t[t.length - 1] >= 72.3);
  assert.ok(t.length >= 3 && t.length <= 8);
  const pts = [[0, 100], [50, 60], [100, 60], [150, 20]]; // flat middle: a naive spline would bulge past 60
  const d = monotonePath(pts);
  const ys = [...d.matchAll(/C[\d.-]+,([\d.-]+) [\d.-]+,([\d.-]+)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(ys.every((y) => y >= 20 - 1e-9 && y <= 100 + 1e-9));
  const flat = d.split(' C')[2]; // the segment between the two y=60 points stays flat
  assert.match(flat, /^[\d.]+,60 [\d.]+,60 100,60$/);
});

// ---------------------------------------------------------------- achievements
test('achievements: every condition is real; locked ones report honest progress', () => {
  const mk = (dates) => ({ journey: { ...J, start: '2026-09-01', duration: 90, waterGoal: 2500 }, checkins: Object.fromEntries(dates.map((d) => [d, { water: 2500, exercise: null, meals: {} }])), unlocked: [], unlockedDates: {} });
  const ids = (u, today) => findNewUnlocks(u, today).map((a) => a.id);
  assert.deepEqual(ids(mk([]), '2026-09-01'), []);
  assert.deepEqual(ids(mk(['2026-09-01']), '2026-09-01'), ['first']);
  assert.deepEqual(ids(mk(run('2026-09-01', 3)), '2026-09-03'), ['first', 'd3']);
  const ctx = achievementContext(mk(run('2026-09-01', 2)), '2026-09-02');
  assert.deepEqual(ACH_DEFS.find((a) => a.id === 'd3').prog(ctx), [2, 3]);
  assert.deepEqual(ACH_DEFS.find((a) => a.id === 'first').prog(achievementContext(mk([]), '2026-09-02')), [0, 1]);
  // a paused streak still counts the longest run that was really achieved
  assert.ok(ids(mk(run('2026-09-01', 3)), '2026-09-20').includes('d3'));
  // already-unlocked achievements are never re-celebrated
  const done = mk(run('2026-09-01', 3));
  done.unlocked = ['first', 'd3'];
  assert.deepEqual(ids(done, '2026-09-03'), []);
  // consistency needs 7 real check-ins, not one perfect day
  assert.ok(!ids(mk(['2026-09-01']), '2026-09-01').includes('consistent'));
  assert.deepEqual(ACH_DEFS.find((a) => a.id === 'consistent').prog(achievementContext(mk(run('2026-09-01', 3)), '2026-09-03')), [3, 7]);
});

// ---------------------------------------------------------------- password policy
test('change password: policy and inline errors', () => {
  assert.deepEqual(validatePasswordChange({ current: 'old-pass-1', next: 'new-pass-22', confirm: 'new-pass-22' }), {});
  assert.deepEqual(Object.keys(validatePasswordChange({ current: '', next: '', confirm: '' })).sort(), ['confirm', 'current', 'next']);
  assert.match(validatePasswordChange({ current: 'a', next: 'short', confirm: 'short' }).next, /at least 8/);
  assert.equal(validatePasswordChange({ current: 'old-pass-1', next: 'new-pass-22', confirm: 'new-pass-23' }).confirm, "Passwords don't match.");
  assert.match(validatePasswordChange({ current: 'same-pass-1', next: 'same-pass-1', confirm: 'same-pass-1' }).next, /different/);
});
