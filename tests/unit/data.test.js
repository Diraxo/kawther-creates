import test from 'node:test';
import assert from 'node:assert/strict';
import { checkinToRows, journeyToRow, rowToJourney, rowsToCheckins, rowsToAchievements } from '../../src/data/mappers.js';

const TODAY = '2026-09-26';

// Test-only fixture (never imported by the app).
const FIXTURE_CHECKIN = {
  mood: 'good', weight: 69.5, water: 2100,
  meals: {
    breakfast: [{ name: 'Oats', notes: '', time: '8:30 AM' }],
    lunch: [{ name: 'Salad', notes: 'light', time: '1:00 PM' }],
    dinner: [{ name: 'Rice and fish', notes: '', time: '7:15 PM' }],
    snacks: [{ name: 'Fruit', notes: '', time: '4:00 PM' }],
  },
  exercise: { type: 'Walking', duration: 30, unit: 'minutes' }, notes: 'ok',
};

test('mappers round-trip a check-in through rows (Supabase shape)', () => {
  const date = '2026-09-02';
  const original = FIXTURE_CHECKIN;
  const { checkin, meals } = checkinToRows('uid-1', date, original);
  assert.equal(checkin.checkin_date, date);
  assert.equal(checkin.user_id, 'uid-1');
  assert.equal(checkin.water_ml, original.water);
  assert.equal(meals.length, 4); // breakfast, lunch, dinner, + snack on i%3===0
  assert.equal(meals[0].eaten_at, '08:30');
  // Simulate what Postgres returns: ids, time with seconds, numeric as string
  const row = { id: 'c1', ...checkin, weight_kg: String(checkin.weight_kg) };
  const mealRows = meals.map((m, i) => ({ id: 'm' + i, checkin_id: 'c1', ...m, eaten_at: m.eaten_at + ':00' }));
  const back = rowsToCheckins([row], mealRows)[date];
  assert.deepEqual(back, original);
});

test('mappers handle rest days and empty meals', () => {
  const c = { mood: null, weight: null, water: 0, meals: { breakfast: [], lunch: [], dinner: [], snacks: [] }, exercise: null, notes: '' };
  const { checkin, meals } = checkinToRows('u', '2026-01-01', c);
  assert.equal(checkin.exercise_type, null);
  assert.equal(checkin.exercise_minutes, null);
  assert.equal(meals.length, 0);
  const back = rowsToCheckins([{ id: 'x', ...checkin }], [])['2026-01-01'];
  assert.deepEqual(back, c);
});

test('journey + achievement mappers', () => {
  const j = { start: '2026-09-02', duration: 90, startWeight: 72, goalWeight: 62, waterGoal: 2500 };
  const row = journeyToRow('u', j);
  assert.equal(row.water_goal_ml, 2500);
  assert.deepEqual(rowToJourney({ ...row, start_weight: '72.0', goal_weight: '62.0' }), j);
  assert.deepEqual(rowsToAchievements([{ achievement_id: 'd3', unlocked_on: '2026-09-05' }]), {
    unlocked: ['d3'],
    unlockedDates: { d3: '2026-09-05' },
  });
});

// ---------- Phase 5–7 additions ----------
import { checkinToPayload, journeyToRpcArgs } from '../../src/data/mappers.js';
import { AuthError, classifyError } from '../../src/data/errors.js';
import { createMilestoneQueue } from '../../src/domain/milestoneQueue.js';

test('checkinToPayload matches the save_checkin RPC contract (no user_id, meals nested)', () => {
  const c = FIXTURE_CHECKIN;
  const p = checkinToPayload(c);
  assert.equal(p.user_id, undefined);
  assert.equal(p.water_ml, c.water);
  assert.deepEqual(Object.keys(p.meals[0]).sort(), ['category', 'eaten_at', 'name', 'notes', 'position']);
  assert.equal(p.meals.length, 4);
  assert.deepEqual(journeyToRpcArgs({ start: '2026-09-02', duration: 90, startWeight: 72, goalWeight: 62, waterGoal: 2500 }), {
    p_start: '2026-09-02', p_duration: 90, p_start_weight: 72, p_goal_weight: 62, p_water_goal: 2500,
  });
});

test('classifyError separates offline / expired session / forbidden / other', () => {
  assert.equal(classifyError(new TypeError('Failed to fetch')).code, 'NETWORK');
  assert.equal(classifyError({ name: 'AuthRetryableFetchError', message: 'x', status: 0 }).code, 'NETWORK');
  assert.equal(classifyError({ message: 'JWT expired', code: 'PGRST301' }).code, 'SESSION_EXPIRED');
  assert.equal(classifyError({ message: 'not authenticated', code: '28000' }).code, 'SESSION_EXPIRED');
  assert.equal(classifyError({ message: 'Auth session missing!' }).code, 'SESSION_EXPIRED');
  assert.equal(classifyError({ message: 'new row violates row-level security policy', code: '42501' }).code, 'FORBIDDEN');
  assert.equal(classifyError({ message: 'boom' }).code, 'UNKNOWN');
  const e = new AuthError('EXISTS');
  assert.equal(classifyError(e), e);
});

test('milestone queue shows every unlock sequentially, in order, then stops', () => {
  const timers = [];
  const shown = [];
  const q = createMilestoneQueue({ present: (a, more) => shown.push([a, more]), gap: 5, schedule: (fn, ms) => timers.push([fn, ms]) });
  const run = () => timers.shift()[0]();
  q.enqueue(['First Step', 'Consistent'], 650);
  q.enqueue(['Third'], 650); // arriving while active must not double-schedule
  assert.equal(timers.length, 1);
  run();
  assert.deepEqual(shown, [['First Step', true]]);
  q.closed(); run();
  assert.deepEqual(shown[1], ['Consistent', true]);
  q.closed(); run();
  assert.deepEqual(shown[2], ['Third', false]);
  q.closed(); run(); // queue drained
  assert.equal(shown.length, 3);
  assert.equal(q.pending, 0);
  q.enqueue(['Again'], 0); // can be reused afterwards
  run();
  assert.equal(shown.length, 4);
  q.clear();
  q.closed();
  assert.equal(timers.length, 0);
});
