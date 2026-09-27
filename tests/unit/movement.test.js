// Movement journal: pure rules (parsing, normalising, display) and the mapper round-trip that decides what is persisted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExercise, cleanMuscles, formatDistance, formatDuration, formatExercise, formatSteps, missingDetails, movementDetail,
  normalizeExercise, parseDistance, parseDuration, parseSteps, splitMinutes,
} from '../../src/domain/movement.js';
import { checkinToPayload, checkinToRows, rowsToCheckins } from '../../src/data/mappers.js';
import { checkinGaps } from '../../src/domain/checkin.js';
import { movementHtml } from '../../src/lib/movementView.js';

const base = { mood: null, weight: null, water: 0, meals: { breakfast: [], lunch: [], dinner: [], snacks: [] }, notes: '' };
/** What Postgres would hand back for what we send (the DB stores exactly the payload columns). */
const roundTrip = (exercise, date = '2026-09-28') => {
  const { checkin } = checkinToRows('u', date, { ...base, exercise });
  return rowsToCheckins([{ id: 'c', ...checkin }], [])[date].exercise;
};
const build = (f) => buildExercise(f);

// ---------- duration ----------
test('duration: hours + minutes parse to whole minutes and read back naturally', () => {
  assert.deepEqual(parseDuration('', '45'), { ok: true, minutes: 45 });
  assert.deepEqual(parseDuration('1', ''), { ok: true, minutes: 60 });
  assert.deepEqual(parseDuration('1', '10'), { ok: true, minutes: 70 });
  assert.deepEqual(parseDuration('2', '0'), { ok: true, minutes: 120 });
  assert.deepEqual(parseDuration('', ''), { ok: true, minutes: null }); // optional: blank is "not recorded"
  assert.deepEqual(parseDuration('0', '0'), { ok: true, minutes: null });
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(60), '1 hr');
  assert.equal(formatDuration(70), '1 hr 10 min');
  assert.equal(formatDuration(120), '2 hr');
  assert.equal(formatDuration(null), '');
  assert.deepEqual(splitMinutes(70), { hours: '1', minutes: '10' });
  assert.deepEqual(splitMinutes(45), { hours: '', minutes: '45' });
  assert.deepEqual(splitMinutes(null), { hours: '', minutes: '' });
});

test('duration: impossible values are rejected', () => {
  for (const [h, m] of [['-1', ''], ['', '-5'], ['', '60'], ['', '75'], ['25', ''], ['24', '1'], ['1.5', ''], ['', '4.5'], ['abc', ''], ['', 'x'], ['1e1', '']]) {
    assert.equal(parseDuration(h, m).ok, false, `${h} h ${m} m`);
  }
  assert.deepEqual(parseDuration('24', '0'), { ok: true, minutes: 1440 });
});

// ---------- distance / steps ----------
test('distance: miles with decimals, optional, never negative', () => {
  assert.deepEqual(parseDistance('5.2'), { ok: true, value: 5.2 });
  assert.deepEqual(parseDistance('3'), { ok: true, value: 3 });
  assert.deepEqual(parseDistance('1,5'), { ok: true, value: 1.5 });
  assert.deepEqual(parseDistance(''), { ok: true, value: null });
  for (const bad of ['-1', 'abc', '1.234', '1001', '1.2.3']) assert.equal(parseDistance(bad).ok, false, bad);
  assert.equal(formatDistance(5.2), '5.2 miles');
  assert.equal(formatDistance(1), '1 mile');
  assert.equal(formatDistance(null), '');
});

test('steps: whole numbers, optional, never negative', () => {
  assert.deepEqual(parseSteps('6420'), { ok: true, value: 6420 });
  assert.deepEqual(parseSteps('6,420'), { ok: true, value: 6420 });
  assert.deepEqual(parseSteps(''), { ok: true, value: null });
  for (const bad of ['-5', '12.5', 'lots', '200001']) assert.equal(parseSteps(bad).ok, false, bad);
  assert.equal(formatSteps(6420), '6,420 steps');
  assert.equal(formatSteps(null), '');
});

// ---------- per-type builds ----------
test('Gym: type only, duration, muscles, both, several muscles, custom muscle', () => {
  assert.deepEqual(build({ type: 'Gym' }).exercise, { type: 'Gym', duration: null, muscles: [], distance: null, steps: null, description: '' });
  assert.equal(build({ type: 'Gym', hours: '1', minutes: '10' }).exercise.duration, 70);
  assert.deepEqual(build({ type: 'Gym', muscles: ['Chest'] }).exercise.muscles, ['Chest']);
  const both = build({ type: 'Gym', hours: '1', minutes: '10', muscles: ['Chest', 'Biceps'] }).exercise;
  assert.equal(formatExercise(both), 'Gym · 1 hr 10 min');
  assert.equal(movementDetail(both), 'Chest · Biceps');
  const custom = build({ type: 'Gym', muscles: ['Chest', 'Forearms', 'forearms', '  ', 'Calves'] }).exercise;
  assert.deepEqual(custom.muscles, ['Chest', 'Forearms', 'Calves']); // de-duplicated, blanks dropped, custom kept
  assert.equal(cleanMuscles(Array.from({ length: 30 }, (_, i) => 'm' + i)).length, 12);
  assert.equal(cleanMuscles(['x'.repeat(100)])[0].length, 40);
});

test('Running: duration, distance, both, and a missing distance is not an error', () => {
  assert.equal(build({ type: 'Running', hours: '', minutes: '45' }).exercise.duration, 45);
  assert.equal(build({ type: 'Running', distance: '5.2' }).exercise.distance, 5.2);
  const both = build({ type: 'Running', minutes: '45', distance: '5.2' }).exercise;
  assert.equal(formatExercise(both), 'Running · 45 min');
  assert.equal(movementDetail(both), '5.2 miles');
  const none = build({ type: 'Running', minutes: '30', distance: '' });
  assert.equal(none.ok, true);
  assert.equal(none.exercise.distance, null);
  assert.equal(build({ type: 'Running', distance: '-2' }).ok, false);
});

test('Walking: duration, steps, both, and missing steps is not an error', () => {
  assert.equal(build({ type: 'Walking', minutes: '50' }).exercise.duration, 50);
  assert.equal(build({ type: 'Walking', steps: '6,420' }).exercise.steps, 6420);
  const both = build({ type: 'Walking', minutes: '50', steps: '6420' }).exercise;
  assert.equal(movementDetail(both), '6,420 steps');
  assert.equal(build({ type: 'Walking', minutes: '20', steps: '' }).ok, true);
  assert.equal(build({ type: 'Walking', steps: '12.5' }).ok, false);
});

test('Home workout and Other: duration, description, both, neither', () => {
  for (const type of ['Home workout', 'Other']) {
    assert.equal(build({ type, minutes: '35' }).exercise.duration, 35);
    assert.equal(build({ type, description: '  Abs + cardio ' }).exercise.description, 'Abs + cardio');
    const both = build({ type, minutes: '35', description: 'Abs + cardio' }).exercise;
    assert.equal(movementDetail(both), 'Abs + cardio');
    const neither = build({ type });
    assert.equal(neither.ok, true);
    assert.equal(neither.exercise.description, '');
  }
  assert.equal(build({ type: 'Other', description: 'x'.repeat(501) }).ok, false);
  assert.equal(build({ type: 'Other', description: 'x'.repeat(500) }).ok, true);
});

test('Rest: no type -> no exercise at all', () => {
  assert.deepEqual(build({ type: null, hours: '1', muscles: ['Chest'] }), { ok: true, exercise: null });
  assert.equal(normalizeExercise(null), null);
  assert.equal(roundTrip(null), null);
});

// ---------- editing: type switches never leak fields ----------
test('changing type drops the details that belong to the old type', () => {
  const gym = { type: 'Gym', duration: 70, muscles: ['Chest', 'Biceps'], distance: 9, steps: 5, description: 'x' };
  assert.deepEqual(normalizeExercise(gym), { type: 'Gym', duration: 70, muscles: ['Chest', 'Biceps'], distance: null, steps: null, description: '' });
  assert.deepEqual(normalizeExercise({ ...gym, type: 'Running' }), { type: 'Running', duration: 70, muscles: [], distance: 9, steps: null, description: '' });
  assert.deepEqual(normalizeExercise({ ...gym, type: 'Walking' }).muscles, []);
  assert.equal(normalizeExercise({ ...gym, type: 'Other' }).muscles.length, 0);
  // and it is what is written: incompatible fields never reach the payload
  const p = checkinToPayload({ ...base, exercise: { ...gym, type: 'Running' } });
  assert.deepEqual([p.exercise_type, p.exercise_muscles, p.exercise_distance_mi, p.exercise_steps, p.exercise_description], ['Running', [], 9, null, '']);
});

// ---------- persistence shape (what the database receives, what comes back) ----------
test('every movement round-trips through the mappers without losing information', () => {
  const cases = [
    { type: 'Gym', duration: 70, muscles: ['Chest', 'Biceps'], distance: null, steps: null, description: '' },
    { type: 'Gym', duration: null, muscles: [], distance: null, steps: null, description: '' },
    { type: 'Running', duration: 45, muscles: [], distance: 5.2, steps: null, description: '' },
    { type: 'Walking', duration: 50, muscles: [], distance: null, steps: 6420, description: '' },
    { type: 'Home workout', duration: 35, muscles: [], distance: null, steps: null, description: 'Abs + cardio' },
    { type: 'Other', duration: 40, muscles: [], distance: null, steps: null, description: 'Cycling around the neighborhood' },
  ];
  for (const ex of cases) assert.deepEqual(roundTrip(ex), ex, ex.type);
});

test('legacy rows (type + minutes only, or no new columns at all) still read back and say what is not recorded', () => {
  const row = { id: 'a', checkin_date: '2026-09-20', mood: null, weight_kg: null, water_ml: 0, exercise_type: 'Gym', exercise_minutes: 30, exercise_unit: 'minutes', notes: '' };
  const ex = rowsToCheckins([row], [])['2026-09-20'].exercise;
  assert.deepEqual(ex, { type: 'Gym', duration: 30, muscles: [], distance: null, steps: null, description: '' });
  const typeOnly = rowsToCheckins([{ ...row, exercise_minutes: null }], [])['2026-09-20'].exercise;
  assert.deepEqual(missingDetails(typeOnly), ['Duration not recorded', 'Muscle groups not recorded']);
  assert.equal(rowsToCheckins([{ ...row, exercise_type: null, exercise_minutes: null }], [])['2026-09-20'].exercise, null);
});

// ---------- historical journal: what each day shows ----------
test('journey day entries show exactly what was saved on that day, and never invent anything', () => {
  const monday = roundTrip({ type: 'Gym', duration: 70, muscles: ['Chest', 'Biceps'] }, '2026-09-28');
  const tuesday = roundTrip({ type: 'Running', duration: 45, distance: 5.2 }, '2026-09-29');
  const wednesday = roundTrip(null, '2026-09-30');
  const mon = movementHtml(monday);
  const tue = movementHtml(tuesday);
  const wed = movementHtml(wednesday);
  assert.match(mon, />GYM</);
  assert.match(mon, /1 hr 10 min/);
  assert.match(mon, /Chest · Biceps/);
  assert.match(tue, />RUNNING</);
  assert.match(tue, /45 min/);
  assert.match(tue, /5\.2 miles/);
  assert.doesNotMatch(tue, /Chest|Biceps/);
  assert.match(wed, /Rest day/);
  assert.match(wed, /Recovery is part of the journey\./);
  assert.doesNotMatch(wed, /min|miles|steps/);
  const bare = movementHtml(normalizeExercise({ type: 'Gym' }));
  assert.match(bare, /Duration not recorded/);
  assert.match(bare, /Muscle groups not recorded/);
  assert.doesNotMatch(bare, /\d+ min/);
  assert.match(movementHtml(normalizeExercise({ type: 'Walking', duration: 50, steps: 6420 })), /6,420 steps/);
  assert.match(movementHtml(normalizeExercise({ type: 'Home workout', duration: 35, description: 'Abs + cardio' })), /HOME WORKOUT/);
  assert.match(movementHtml(normalizeExercise({ type: 'Other', duration: 40 })), /Details not recorded/);
});

test('user text is escaped before it is rendered', () => {
  const html = movementHtml(normalizeExercise({ type: 'Other', description: '<img src=x onerror=alert(1)>' }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(movementHtml(normalizeExercise({ type: 'Gym', muscles: ['<b>x</b>'] })), /<b>x/);
});

test('the completion sheet reports only movement that was actually recorded', () => {
  const meals = { breakfast: [{ name: 'x' }], lunch: [], dinner: [], snacks: [] };
  const g = checkinGaps({ meals, water: 5000, weight: 60, exercise: normalizeExercise({ type: 'Gym', duration: 70 }) }, 5000);
  assert.equal(g.find((x) => x.id === 'move').text, 'Workout complete: Gym · 1 hr 10 min');
  const typeOnly = checkinGaps({ meals, water: 5000, weight: 60, exercise: normalizeExercise({ type: 'Gym' }) }, 5000);
  assert.equal(typeOnly.find((x) => x.id === 'move').text, 'Workout complete: Gym'); // no fabricated minutes
});
