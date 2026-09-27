// Runs supabase/schema.sql against a REAL Postgres (PGlite, in-process WASM) with a Supabase-style
// auth stub, then attacks it as different users through the `authenticated`/`anon` roles.
// This proves the SQL (RLS, grants, composite FK, RPC atomicity). It does NOT prove the hosted
// Supabase project is configured the same way — that is what tests/live/ is for.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const CAROL = '33333333-3333-3333-3333-333333333333';

let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb,
      encrypted_password text, last_sign_in_at timestamptz, recovery_sent_at timestamptz);
    create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade);
    create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text not null default 'unverified');
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable
      as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
  `);
  await db.exec(SCHEMA);
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    insert into auth.users values ('${A}', 'a@x.com', '{"full_name":"Alice"}'),
                                  ('${B}', 'b@x.com', '{"full_name":"Bob"}'),
                                  ('${CAROL}', 'carol@example.com', '{"full_name":"Kawther"}');
  `);
});

/** Runs fn as a Supabase user (or anon when uid is null); always resets the role afterwards. */
async function as(uid, fn) {
  await db.exec(uid ? `set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);` : `set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const denied = (p) => assert.rejects(p, /permission denied|row-level security|violates|not authenticated/i);
/** A write the browser must not be able to make: either refused outright (no privilege) or it matches 0 rows. Never a change. */
const noEffect = async (p) => {
  try { assert.equal((await p).affectedRows, 0); } catch (e) { assert.match(String(e.message), /permission denied|row-level security/i); }
};
const payload = (over = {}) => ({
  mood: 'good', weight_kg: 70.5, water_ml: 2000, exercise_type: 'Gym', exercise_minutes: 30, notes: 'n',
  meals: [
    { category: 'breakfast', name: 'Eggs', notes: '', eaten_at: '08:30', position: 0 },
    { category: 'lunch', name: 'Salad', notes: 'x', eaten_at: '13:00', position: 0 },
  ],
  ...over,
});
const todayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const save = (uid, date, p) => as(uid, () => db.query('select public.save_checkin($1::date, $2::jsonb) as id', [date, JSON.stringify(p)]));

test('signup trigger creates a profile from auth.users (no password column anywhere in public)', async () => {
  const r = await db.query(`select id, full_name, email, onboarded from public.profiles order by email`);
  assert.deepEqual(r.rows.map((x) => x.full_name), ['Alice', 'Bob', 'Kawther']);
  assert.equal(r.rows.every((x) => x.onboarded === false), true);
  const cols = await db.query(`select column_name from information_schema.columns where table_schema='public' and column_name ilike '%pass%'`);
  assert.equal(cols.rows.length, 0);
});

test('anon can read/write nothing, and cannot call the RPCs', async () => {
  await denied(as(null, () => db.query('select * from public.profiles')));
  await denied(as(null, () => db.query('select * from public.checkins')));
  await denied(as(null, () => db.query(`select public.save_checkin('2026-09-01', '{}'::jsonb)`)));
});

test('journey: create_journey is atomic + sets onboarded; users see only their own', async () => {
  await as(A, () => db.query(`select public.create_journey(current_date, 90, 72, 62, 2500)`));
  await as(B, () => db.query(`select public.create_journey('2026-09-10', 30, 90, 80, 3000)`));
  assert.equal((await as(A, () => db.query('select * from public.journeys'))).rows.length, 1);
  assert.equal((await as(A, () => db.query('select onboarded from public.profiles'))).rows[0].onboarded, true);
  assert.equal((await as(B, () => db.query('select duration_days from public.journeys'))).rows[0].duration_days, 30);
  // constraint failure inside the RPC rolls back the profile flag too
  await as(CAROL, async () => { await assert.rejects(db.query(`select public.create_journey('2026-09-01', 6, 72, 62, 2500)`), /violates/); });
  await as(CAROL, async () => { await assert.rejects(db.query(`select public.create_journey('2026-09-01', 366, 72, 62, 2500)`), /violates/); });
  assert.equal((await db.query(`select onboarded from public.profiles where id='${CAROL}'`)).rows[0].onboarded, false);
});

test('journey: any custom length 7..365 is accepted', async () => {
  for (const d of [7, 45, 120, 365]) {
    await as(A, () => db.query(`select public.create_journey(current_date, ${d}, 72, 62, 2500)`));
    assert.equal((await as(A, () => db.query('select duration_days from public.journeys'))).rows[0].duration_days, d);
  }
  await as(A, () => db.query(`select public.create_journey('2026-09-01', 90, 72, 62, 2500)`));
});

test('save_checkin: upserts, replaces meals, persists round trip', async () => {
  await save(A, '2026-09-02', payload());
  await save(A, '2026-09-02', payload({ water_ml: 2600, meals: [{ category: 'dinner', name: 'Fish', notes: '', eaten_at: '19:00', position: 0 }] }));
  const c = (await as(A, () => db.query('select * from public.checkins'))).rows;
  assert.equal(c.length, 1); // upsert, not duplicate
  assert.equal(c[0].water_ml, 2600);
  const m = (await as(A, () => db.query('select category, name from public.checkin_meals'))).rows;
  assert.deepEqual(m, [{ category: 'dinner', name: 'Fish' }]); // old meals replaced
});

test('save_checkin is ATOMIC: a bad meal rolls back the check-in change and keeps old meals', async () => {
  await save(A, '2026-09-03', payload());
  const before = (await as(A, () => db.query('select water_ml from public.checkins where checkin_date = $1', ['2026-09-03']))).rows[0].water_ml;
  const bad = payload({ water_ml: 9999, meals: [
    { category: 'breakfast', name: 'Fine', notes: '', eaten_at: '08:00', position: 0 },
    { category: 'brunch', name: 'Bad category', notes: '', eaten_at: '09:00', position: 1 },
  ] });
  await assert.rejects(save(A, '2026-09-03', bad), /violates|check/i);
  const after = (await as(A, () => db.query('select water_ml from public.checkins where checkin_date = $1', ['2026-09-03']))).rows[0].water_ml;
  assert.equal(after, before);
  const meals = (await as(A, () => db.query(`select name from public.checkin_meals m join public.checkins c on c.id=m.checkin_id where c.checkin_date='2026-09-03' order by m.category`))).rows;
  assert.deepEqual(meals.map((x) => x.name), ['Eggs', 'Salad']);
  // a brand-new day with a bad meal leaves NO orphan check-in
  await assert.rejects(save(A, '2026-09-04', bad));
  assert.equal((await as(A, () => db.query(`select 1 from public.checkins where checkin_date='2026-09-04'`))).rows.length, 0);
});

test('save_checkin rejects unauthenticated callers, future dates and oversized payloads', async () => {
  await assert.rejects(as(null, () => db.query(`select public.save_checkin('2026-09-01', '{}'::jsonb)`)), /permission denied|not authenticated/);
  await assert.rejects(save(A, '2099-01-01', payload()), /invalid check-in date/);
  const many = Array.from({ length: 41 }, (_, i) => ({ category: 'snacks', name: 'x' + i, eaten_at: '10:00', position: i }));
  await assert.rejects(save(A, '2026-09-05', payload({ meals: many })), /invalid check-in payload/);
});

test('RLS/IDOR: B cannot read, update, delete or forge rows belonging to A', async () => {
  const aCheckin = (await db.query(`select id from public.checkins where user_id='${A}' limit 1`)).rows[0].id;
  // reads: B sees nothing of A's, even when asking by A's id
  assert.equal((await as(B, () => db.query('select * from public.checkins where id = $1', [aCheckin]))).rows.length, 0);
  assert.equal((await as(B, () => db.query('select * from public.checkin_meals where checkin_id = $1', [aCheckin]))).rows.length, 0);
  assert.equal((await as(B, () => db.query('select * from public.profiles where id = $1', [A]))).rows.length, 0);
  assert.equal((await as(B, () => db.query('select * from public.journeys where user_id = $1', [A]))).rows.length, 0);
  // updates/deletes never change anything (now refused outright: the browser has no write privilege on these tables)
  await noEffect(as(B, () => db.query(`update public.checkins set water_ml = 0 where id = $1`, [aCheckin])));
  await noEffect(as(B, () => db.query(`delete from public.checkin_meals where checkin_id = $1`, [aCheckin])));
  await noEffect(as(B, () => db.query(`update public.journeys set water_goal_ml = 500 where user_id = $1`, [A])));
  const upp = await as(B, () => db.query(`update public.profiles set full_name = 'pwned' where id = $1`, [A]));
  assert.equal(upp.affectedRows, 0);
  await save(B, '2026-09-02', payload()); // B has a row of their own, so the reassignment below is a real attack
  // forging: inserting rows as A, or re-assigning ownership, is rejected
  await denied(as(B, () => db.query(`insert into public.checkins (user_id, checkin_date) values ('${A}', '2026-01-01')`)));
  await denied(as(B, () => db.query(`insert into public.user_achievements values ('${A}', 'd7', '2026-09-01')`)));
  await denied(as(B, () => db.query(`update public.checkins set user_id = '${A}' where user_id = '${B}'`)));
  // A's data is untouched
  assert.equal((await db.query(`select full_name from public.profiles where id='${A}'`)).rows[0].full_name, 'Alice');
});

test('IDOR via foreign key: B cannot attach a meal to A\'s check-in (composite FK)', async () => {
  const aCheckin = (await db.query(`select id from public.checkins where user_id='${A}' limit 1`)).rows[0].id;
  await as(B, async () => {
    await assert.rejects(
      db.query(`insert into public.checkin_meals (checkin_id, user_id, category, name, eaten_at) values ($1, '${B}', 'lunch', 'injected', '12:00')`, [aCheckin]),
      /foreign key|violates|permission denied/i,
    );
  });
  // and the composite FK holds on its own, even for the table owner (defence in depth: not just a missing privilege)
  await assert.rejects(
    db.query(`insert into public.checkin_meals (checkin_id, user_id, category, name, eaten_at) values ($1, '${B}', 'lunch', 'injected', '12:00')`, [aCheckin]),
    /foreign key/i,
  );
  assert.equal((await db.query(`select 1 from public.checkin_meals where name='injected'`)).rows.length, 0);
});

test('profiles: users cannot change email/id, insert or delete profiles', async () => {
  await denied(as(A, () => db.query(`update public.profiles set email = 'carol@example.com' where id = '${A}'`)));
  await denied(as(A, () => db.query(`insert into public.profiles (id) values (gen_random_uuid())`)));
  await denied(as(A, () => db.query(`delete from public.profiles where id = '${A}'`)));
  await denied(as(A, () => db.query(`delete from public.checkins`)));
  await denied(as(A, () => db.query(`delete from public.journeys`)));
});

// The browser has no write privilege on user_achievements at all (see tests/integration/security.test.js for the full attack
// matrix). Legitimate unlocks come from save_checkin, derived from the user's real rows.
test('achievements: derived by save_checkin from real data; own rows only; ids are constrained', async () => {
  await save(A, todayPlus(0), payload());
  assert.deepEqual((await as(A, () => db.query('select achievement_id from public.user_achievements'))).rows.map((r) => r.achievement_id), ['first']);
  assert.equal((await as(B, () => db.query('select * from public.user_achievements'))).rows.length, 0);
  await denied(as(A, () => db.query(`insert into public.user_achievements values ('${A}', 'first', '2026-09-02')`)));
  await assert.rejects(db.query(`insert into public.user_achievements values ('${A}', 'godmode', '2026-09-02')`), /violates/); // table constraint, even for the owner
});

// ---------- exercise unit (movement duration: minutes canonical + the unit the user entered) ----------
test('exercise_unit: hours/minutes persist through save_checkin; a re-save updates (never duplicates); bad units rejected', async () => {
  await save(A, '2026-09-10', payload({ exercise_type: 'Gym', exercise_minutes: 90, exercise_unit: 'hours' }));
  let r = (await as(A, () => db.query(`select exercise_minutes, exercise_unit from public.checkins where checkin_date='2026-09-10'`))).rows;
  assert.deepEqual(r, [{ exercise_minutes: 90, exercise_unit: 'hours' }]);
  await save(A, '2026-09-10', payload({ exercise_type: 'Gym', exercise_minutes: 90, exercise_unit: 'minutes' }));
  r = (await as(A, () => db.query(`select exercise_minutes, exercise_unit from public.checkins where checkin_date='2026-09-10'`))).rows;
  assert.deepEqual(r, [{ exercise_minutes: 90, exercise_unit: 'minutes' }]); // same row, unit updated
  await save(A, '2026-09-11', payload({ exercise_type: null, exercise_minutes: null })); // no unit sent -> default
  assert.equal((await as(A, () => db.query(`select exercise_unit from public.checkins where checkin_date='2026-09-11'`))).rows[0].exercise_unit, 'minutes');
  await assert.rejects(save(A, '2026-09-12', payload({ exercise_unit: 'days' })), /violates|check/i);
});

// ---------- goal achievement ----------
// (the 2026-09-27/28/29 migration re-run tests live in tests/integration/upgrade.test.js: they need the pre-hardening shape)
test('goal achievement: post-goal choice needs a server-derived goal, is constrained, user-scoped, reset by create_journey', async () => {
  await as(CAROL, () => db.query(`select public.create_journey('2026-09-01'::date, 60, 48, 65, 2500)`));
  const set = (mode, w) => as(CAROL, () => db.query(`select public.set_post_goal($1, $2)`, [mode, w]));
  // not reached yet: the choice cannot be made (and cannot be forged by writing the columns directly)
  await assert.rejects(set('maintain', null), /goal not reached/);
  await noEffect(as(CAROL, () => db.query(`update public.journeys set post_goal_mode='maintain' where user_id=$1`, [CAROL])));
  // reach it for real: a check-in at/above the goal weight (a GAIN journey 48 -> 65)
  await save(CAROL, todayPlus(0), payload({ weight_kg: 65.2 }));
  assert.deepEqual((await as(CAROL, () => db.query(`select achievement_id from public.user_achievements order by 1`))).rows.map((r) => r.achievement_id), ['first', 'goal']);
  await set('new_goal', 68);
  await set('maintain', null);
  await set('journal', null);
  await assert.rejects(set('new_goal', null), /invalid goal weight/);
  await assert.rejects(set('maintain', 70), /invalid goal weight/);
  await assert.rejects(set('sprint', null), /invalid mode/);
  await assert.rejects(set('new_goal', 500), /invalid goal weight/);
  await assert.rejects(set('new_goal', 65), /already reached/);
  // another user cannot touch CAROL's choice: they have no goal of their own
  await assert.rejects(as(B, () => db.query(`select public.set_post_goal('maintain', null)`)), /goal not reached/);
  assert.equal((await db.query(`select post_goal_mode from public.journeys where user_id=$1`, [CAROL])).rows[0].post_goal_mode, 'journal');
  await set('new_goal', 68);
  // (a journey that already has check-ins keeps its start date and starting weight; its goal may still change to an unreached one)
  await as(CAROL, () => db.query(`select public.create_journey('2026-09-01'::date, 60, 48, 70, 2500)`));
  const r = (await as(CAROL, () => db.query(`select post_goal_mode, next_goal_weight from public.journeys where user_id=$1`, [CAROL]))).rows[0];
  assert.deepEqual(r, { post_goal_mode: null, next_goal_weight: null });
});

// ---------- journey complete ----------
const DAVE = '44444444-4444-4444-4444-444444444444';

test('journey complete: start_next_journey archives the finished journey, keeps it immutable, one active at a time', async () => {
  await db.exec(`insert into auth.users values ('${DAVE}', 'dave@example.com', '{"full_name":"Dave"}')`);
  const q = (sql, args) => as(DAVE, () => db.query(sql, args));
  await q(`select public.create_journey(current_date, 60, 48, 65, 2500)`);
  // arrange a journey that finished yesterday (owner-level fixture: create_journey refuses a journey that is already over)
  await db.query(`update public.journeys set start_date = $2 where user_id = $1`, [DAVE, todayPlus(-60)]); // last day = yesterday
  const next = (start, mode = 'new_goal', goal = 62) => q(`select public.start_next_journey($1::date, 90, 65, $2, 2500, $3)`, [start, goal, mode]);
  await assert.rejects(next(todayPlus(-1)), /after the previous one ends/);
  await assert.rejects(next(todayPlus(0), 'sprint'), /invalid mode/);
  await next(todayPlus(0));
  const rows = (await q(`select start_date::text as s, completed_on::text as c, goal_weight::float as g, post_goal_mode as m from public.journeys where user_id=$1 order by start_date`, [DAVE])).rows;
  assert.deepEqual(rows, [{ s: todayPlus(-60), c: todayPlus(-1), g: 65, m: null }, { s: todayPlus(0), c: null, g: 62, m: null }]);
  // the finished journey cannot be edited, and a second active journey cannot exist
  await noEffect(q(`update public.journeys set goal_weight = 90 where user_id=$1 and completed_on is not null`, [DAVE]));
  await denied(q(`insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight) values ($1,'2021-01-01',30,60,60)`, [DAVE]));
  await assert.rejects( // and the unique index holds on its own, even for the table owner
    db.query(`insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight) values ($1,'2021-01-01',30,60,60)`, [DAVE]), /unique|duplicate/i);
  // onboarding's create_journey only ever touches the ACTIVE journey
  await q(`select public.create_journey(current_date, 30, 65, 66, 2500)`);
  const after = (await q(`select start_date::text as s, duration_days as d from public.journeys where user_id=$1 order by start_date`, [DAVE])).rows;
  assert.deepEqual(after, [{ s: todayPlus(-60), d: 60 }, { s: todayPlus(0), d: 30 }]);
});

test('journey complete: cannot start the next journey before the last day, and other users cannot touch it', async () => {
  const CAT = '55555555-5555-5555-5555-555555555555';
  await db.exec(`insert into auth.users values ('${CAT}', 'cat@example.com', '{"full_name":"Cat"}')`);
  await as(CAT, () => db.query(`select public.create_journey(current_date, 60, 48, 65, 2500)`));
  await assert.rejects(as(CAT, () => db.query(`select public.start_next_journey(current_date + 60, 30, 48, 50, 2500, 'journal')`)), /not complete yet/);
  // 'Journey Complete' is derived from the journey's dates: not yet earned, so claiming grants nothing (and cannot be forged)
  assert.deepEqual((await as(CAT, () => db.query(`select public.claim_journey_complete() as r`))).rows[0].r, { ok: true, unlocked: [] });
  await denied(as(CAT, () => db.query(`insert into public.user_achievements values ($1, 'journey', current_date)`, [CAT])));
  const EVE = '66666666-6666-6666-6666-666666666666'; // no journey at all
  await db.exec(`insert into auth.users values ('${EVE}', 'eve@example.com', '{"full_name":"Eve"}')`);
  await assert.rejects(as(EVE, () => db.query(`select public.start_next_journey(current_date + 60, 30, 48, 50, 2500, 'journal')`)), /no active journey/);
});
