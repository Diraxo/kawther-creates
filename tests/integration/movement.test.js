// Movement journal against REAL Postgres (PGlite) with schema.sql applied: persistence, one row per day, type/detail
// integrity, validation, ownership, and that the existing achievement rules did not change.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, harness, uuid } from './helpers.js';

const [A, B] = [uuid(0xa1), uuid(0xb2)];
let db, h;

before(async () => {
  db = await makeDb(['supabase/schema.sql']);
  h = harness(db);
  for (const [id, n] of [[A, 'A'], [B, 'B']]) { await h.addUser(id, n); await h.journey(id, { start: h.day(-10) }); }
});

const move = (o = {}) => h.payload({ exercise_type: 'Gym', exercise_minutes: null, exercise_unit: 'minutes', ...o });
const rows = (uid) => h.as(uid, () => db.query(`select checkin_date::text d, exercise_type t, exercise_minutes m, exercise_muscles mu, exercise_distance_mi::float8 dist,
  exercise_steps st, exercise_description descr from public.checkins order by checkin_date`)).then((r) => r.rows);
const save = async (uid, date, p) => { await h.resetLimits(); return h.save(uid, date, p); };
const rejects = (uid, date, p, re) => assert.rejects(save(uid, date, p), re, JSON.stringify(p));

test('Gym: type only, duration, muscles, duration + several muscles incl. a custom one all persist', async () => {
  const d = h.day(-9);
  await save(A, d, move());
  assert.deepEqual((await rows(A))[0], { d, t: 'Gym', m: null, mu: [], dist: null, st: null, descr: '' });
  await save(A, d, move({ exercise_minutes: 70 }));
  assert.equal((await rows(A))[0].m, 70);
  await save(A, d, move({ exercise_muscles: ['Chest'] }));
  assert.deepEqual((await rows(A))[0].mu, ['Chest']);
  await save(A, d, move({ exercise_minutes: 70, exercise_muscles: ['Chest', 'Biceps', 'Forearms'] }));
  const r = (await rows(A))[0];
  assert.deepEqual([r.m, r.mu], [70, ['Chest', 'Biceps', 'Forearms']]);
});

test('Running, Walking, Home workout and Other persist their own detail (and only that)', async () => {
  await save(A, h.day(-8), move({ exercise_type: 'Running', exercise_minutes: 45, exercise_distance_mi: 5.2 }));
  await save(A, h.day(-7), move({ exercise_type: 'Walking', exercise_minutes: 50, exercise_steps: 6420 }));
  await save(A, h.day(-6), move({ exercise_type: 'Home workout', exercise_minutes: 35, exercise_description: 'Abs + cardio' }));
  await save(A, h.day(-5), move({ exercise_type: 'Other', exercise_minutes: 40, exercise_description: 'Cycling around the neighborhood' }));
  await save(A, h.day(-4), move({ exercise_type: 'Running' })); // no duration, no distance: still legitimate
  const by = Object.fromEntries((await rows(A)).map((r) => [r.d, r]));
  assert.deepEqual([by[h.day(-8)].t, by[h.day(-8)].m, by[h.day(-8)].dist], ['Running', 45, 5.2]);
  assert.deepEqual([by[h.day(-7)].t, by[h.day(-7)].m, by[h.day(-7)].st], ['Walking', 50, 6420]);
  assert.deepEqual([by[h.day(-6)].t, by[h.day(-6)].descr], ['Home workout', 'Abs + cardio']);
  assert.deepEqual([by[h.day(-5)].t, by[h.day(-5)].descr], ['Other', 'Cycling around the neighborhood']);
  assert.deepEqual([by[h.day(-4)].t, by[h.day(-4)].m, by[h.day(-4)].dist], ['Running', null, null]);
});

test('a rest day stores no movement details at all, even if the payload carries some', async () => {
  const d = h.day(-3);
  await save(A, d, move({ exercise_type: null, exercise_minutes: null, exercise_muscles: ['Chest'], exercise_distance_mi: 3, exercise_steps: 10, exercise_description: 'x' }));
  assert.deepEqual((await rows(A)).find((r) => r.d === d), { d, t: null, m: null, mu: [], dist: null, st: null, descr: '' });
});

test('editing: one row per day (never a duplicate) and switching type drops the old type details', async () => {
  const d = h.day(-2);
  await save(A, d, move({ exercise_minutes: 70, exercise_muscles: ['Chest', 'Biceps'] }));
  await save(A, d, move({ exercise_type: 'Running', exercise_minutes: 70, exercise_muscles: ['Chest', 'Biceps'], exercise_distance_mi: 5 })); // stale gym field sent along
  const same = (await rows(A)).filter((r) => r.d === d);
  assert.equal(same.length, 1, 'still one check-in for the day');
  assert.deepEqual(same[0], { d, t: 'Running', m: 70, mu: [], dist: 5, st: null, descr: '' });
  await save(A, d, move({ exercise_minutes: 70, exercise_muscles: ['Legs'], exercise_distance_mi: 5, exercise_steps: 9, exercise_description: 'x' })); // back to Gym
  assert.deepEqual((await rows(A)).find((r) => r.d === d), { d, t: 'Gym', m: 70, mu: ['Legs'], dist: null, st: null, descr: '' });
  assert.equal((await h.as(A, () => db.query('select count(*)::int n from public.checkins where checkin_date = $1', [d]))).rows[0].n, 1);
});

test('validation: durations, distance, steps, description, muscle groups', async () => {
  const d = h.day(-1);
  const bad = [
    [{ exercise_distance_mi: -1, exercise_type: 'Running' }], [{ exercise_distance_mi: 1001, exercise_type: 'Running' }], [{ exercise_distance_mi: 1.234, exercise_type: 'Running' }], [{ exercise_distance_mi: 'far', exercise_type: 'Running' }],
    [{ exercise_steps: -1, exercise_type: 'Walking' }], [{ exercise_steps: 1.5, exercise_type: 'Walking' }], [{ exercise_steps: 200001, exercise_type: 'Walking' }],
    [{ exercise_description: 'x'.repeat(501), exercise_type: 'Other' }], [{ exercise_description: 5, exercise_type: 'Other' }],
    [{ exercise_muscles: 'Chest' }], [{ exercise_muscles: [1] }], [{ exercise_muscles: ['x'.repeat(41)] }], [{ exercise_muscles: [''] }],
    [{ exercise_muscles: Array.from({ length: 13 }, (_, i) => 'm' + i) }],
    [{ exercise_type: null, exercise_minutes: 30 }], [{ exercise_minutes: 1441 }], [{ exercise_minutes: -5 }],
  ];
  for (const [o] of bad) await rejects(A, d, move(o), /invalid check-in payload/);
  const good = [
    { exercise_type: 'Running', exercise_distance_mi: 0 }, { exercise_type: 'Running', exercise_distance_mi: 1000 }, { exercise_type: 'Walking', exercise_steps: 200000 },
    { exercise_type: 'Other', exercise_description: 'x'.repeat(500) }, { exercise_muscles: Array.from({ length: 12 }, (_, i) => 'm' + i) }, { exercise_muscles: ['x'.repeat(40)] },
    { exercise_muscles: [], exercise_minutes: null }, { exercise_minutes: 1440 },
  ];
  for (const o of good) await save(A, d, move(o));
});

test('the table itself refuses details that do not match the type (defence in depth beneath the RPC)', async () => {
  const d = h.day(-10);
  const ins = (cols, vals) => db.exec(`insert into public.checkins (user_id, checkin_date, ${cols}) values ('${B}', '${d}', ${vals})`);
  await assert.rejects(ins('exercise_type, exercise_muscles', `'Running', '{Chest}'`), /violates check/i);
  await assert.rejects(ins('exercise_type, exercise_distance_mi', `'Gym', 3`), /violates check/i);
  await assert.rejects(ins('exercise_type, exercise_steps', `'Gym', 3`), /violates check/i);
  await assert.rejects(ins('exercise_type, exercise_description', `'Walking', 'x'`), /violates check/i);
  await assert.rejects(ins('exercise_muscles', `'{Chest}'`), /violates check/i); // rest day with details
  await assert.rejects(ins('exercise_minutes', '30'), /violates check/i); // minutes without a type
  await ins('exercise_type', `'Gym'`); // type alone is fine
});

test('ownership and RLS are unchanged: nobody reads another user\'s movement, and the browser still cannot write rows directly', async () => {
  const mine = await rows(A);
  assert.ok(mine.some((r) => r.t === 'Running' && r.dist === 5.2 || r.t === 'Gym'));
  const theirs = await rows(B);
  assert.ok(theirs.every((r) => r.mu.length === 0 && r.dist == null), 'B sees only B\'s rows');
  assert.equal(theirs.length, 1);
  await assert.rejects(h.as(A, () => db.query(`update public.checkins set exercise_muscles = '{Legs}' where user_id = $1`, [A])), /permission denied/);
  await assert.rejects(h.as(A, () => db.query(`insert into public.checkins (user_id, checkin_date, exercise_type) values ($1, current_date, 'Gym')`, [A])), /permission denied/);
  await assert.rejects(h.as(null, () => db.query('select exercise_muscles from public.checkins')), /permission denied/);
});

test('achievements are unchanged: Active Week still needs 4 real movement days in 7, and details add nothing', async () => {
  const u = uuid(0xc3);
  await h.addUser(u, 'C');
  await h.journey(u, { start: h.day(-10) });
  const has = async () => (await h.as(u, () => db.query(`select achievement_id a from public.user_achievements`))).rows.map((r) => r.a);
  // three movement days full of details: not enough
  for (const n of [-3, -2, -1]) await save(u, h.day(n), move({ exercise_minutes: 90, exercise_muscles: ['Chest', 'Legs', 'Core'] }));
  assert.ok(!(await has()).includes('active'));
  // a rest day carrying "details" does not count
  await save(u, h.day(-4), move({ exercise_type: null, exercise_minutes: null, exercise_muscles: ['Chest'] }));
  assert.ok(!(await has()).includes('active'));
  // a fourth real movement day (type only, no details at all) does count, exactly as before
  await save(u, h.day(0), move());
  assert.ok((await has()).includes('active'));
});
