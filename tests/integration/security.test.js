// Security regression suite, run against REAL Postgres (PGlite) with schema.sql applied.
// The browser is treated as hostile: everything below is something a user could do from DevTools with their own JWT.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, harness, uuid } from './helpers.js';
import { ACH_DEFS, achievementContext } from '../../src/domain/achievements.js';
import { goalAchievement } from '../../src/domain/goal.js';
import { goalDate } from '../../src/domain/journey.js';

const [ME, VICTIM, OTHER, MFA_USER] = [uuid(1), uuid(2), uuid(3), uuid(4)];
let db, as, addUser, day, payload, save, journey, resetLimits, one;

before(async () => {
  db = await makeDb(['supabase/schema.sql']);
  ({ as, addUser, day, payload, save, journey, resetLimits, one } = harness(db));
  for (const [id, n] of [[ME, 'Me'], [VICTIM, 'Victim'], [OTHER, 'Other'], [MFA_USER, 'Mfa']]) await addUser(id, n);
  await journey(ME); await journey(VICTIM); await journey(OTHER);
  await save(VICTIM, day(0), payload({ weight_kg: 60 })); // victim: a check-in, an achievement ('first'), a journey
});

const REFUSED = /permission denied|row-level security|violates/i;
const refuse = (p) => assert.rejects(p, REFUSED);
/** The write either errors with a privilege error or matches nothing. It must never change a row. */
const noEffect = async (p) => {
  try { assert.equal((await p).affectedRows, 0); } catch (e) { assert.match(String(e.message), REFUSED); }
};
const snapshot = async () => JSON.stringify(await Promise.all(['journeys', 'checkins', 'checkin_meals', 'user_achievements', 'profiles']
  .map(async (t) => (await db.query(`select * from public.${t} order by 1, 2`)).rows)));

// =====================================================================================================================
// PHASE 1 + 2: achievement forgery and direct table writes
// =====================================================================================================================
test('achievements: the browser cannot insert, update, delete or upsert - for itself or anyone else', async () => {
  const before = await snapshot();
  const forge = [
    `insert into public.user_achievements values ('${ME}', 'goal', '${day(0)}')`,
    `insert into public.user_achievements values ('${ME}', 'd14', '${day(0)}')`,
    `insert into public.user_achievements values ('${ME}', 'consistent', '${day(0)}')`,
    `insert into public.user_achievements values ('${ME}', 'journey', '${day(0)}')`,
    `insert into public.user_achievements (user_id, achievement_id, unlocked_on) values ('${ME}', 'first', '${day(0)}') on conflict (user_id, achievement_id) do update set unlocked_on = '2000-01-01'`,
    `insert into public.user_achievements values ('${VICTIM}', 'goal', '${day(0)}')`,        // grant another user an achievement
    `update public.user_achievements set achievement_id = 'goal' where user_id = '${VICTIM}'`, // change achievement id
    `update public.user_achievements set unlocked_on = '2000-01-01' where user_id = '${VICTIM}'`, // change unlock date
    `update public.user_achievements set user_id = '${ME}' where user_id = '${VICTIM}'`,       // steal
    `update public.user_achievements set unlocked_on = '2000-01-01'`,                            // blanket update
    `delete from public.user_achievements where user_id = '${VICTIM}'`,
    `delete from public.user_achievements`,
  ];
  for (const sql of forge) await noEffect(as(ME, () => db.query(sql)));
  assert.equal(await snapshot(), before, 'no achievement (or any other) row changed');
  assert.equal((await as(ME, () => db.query('select * from public.user_achievements'))).rows.length, 0, 'ME still has none');
});

test('achievements: anon cannot read or write them either', async () => {
  await refuse(as(null, () => db.query('select * from public.user_achievements')));
  await refuse(as(null, () => db.query(`insert into public.user_achievements values ('${ME}', 'goal', '${day(0)}')`)));
});

test('direct writes to journeys, checkins, checkin_meals, profiles are refused (own row and another user\'s row)', async () => {
  const [myCheckinDate, cid] = [day(0), null];
  await save(ME, myCheckinDate, payload());
  const mine = await one(`select id from public.checkins where user_id = $1`, [ME]);
  const theirs = await one(`select id from public.checkins where user_id = $1`, [VICTIM]);
  const before = await snapshot();
  const attacks = [
    // journeys: create a 2nd one, edit own/other, complete it, flip goal state, reassign ownership
    `insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight) values ('${ME}', '${day(0)}', 30, 60, 60)`,
    `insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight) values ('${VICTIM}', '${day(0)}', 30, 60, 60)`,
    `update public.journeys set goal_weight = start_weight where user_id = '${ME}'`,
    `update public.journeys set duration_days = 7, completed_on = current_date where user_id = '${ME}'`,
    `update public.journeys set post_goal_mode = 'maintain' where user_id = '${ME}'`,
    `update public.journeys set water_goal_ml = 500 where user_id = '${VICTIM}'`,
    `update public.journeys set user_id = '${ME}' where user_id = '${VICTIM}'`,
    `delete from public.journeys where user_id = '${ME}'`,
    // checkins
    `insert into public.checkins (user_id, checkin_date, weight_kg) values ('${ME}', '${day(-3)}', 1)`,
    `insert into public.checkins (user_id, checkin_date) values ('${VICTIM}', '${day(-3)}')`,
    `update public.checkins set weight_kg = 5000, notes = repeat('x', 999999) where user_id = '${ME}'`,
    `update public.checkins set water_ml = 0 where id = '${theirs.id}'`,
    `update public.checkins set user_id = '${VICTIM}' where id = '${mine.id}'`,
    `delete from public.checkins where id = '${mine.id}'`,
    `delete from public.checkins where id = '${theirs.id}'`,
    // meals
    `insert into public.checkin_meals (checkin_id, user_id, category, name, eaten_at) values ('${mine.id}', '${ME}', 'lunch', 'x', '12:00')`,
    `insert into public.checkin_meals (checkin_id, user_id, category, name, eaten_at) values ('${theirs.id}', '${VICTIM}', 'lunch', 'x', '12:00')`,
    `update public.checkin_meals set name = 'pwned'`,
    `delete from public.checkin_meals`,
    // profiles: only full_name is client-writable; onboarded/email/id are not
    `update public.profiles set onboarded = true where id = '${ME}'`,
    `update public.profiles set email = 'x@y.z' where id = '${ME}'`,
    `update public.profiles set id = '${uuid(9)}' where id = '${ME}'`,
    `update public.profiles set full_name = 'pwned' where id = '${VICTIM}'`,
    `insert into public.profiles (id) values ('${uuid(9)}')`,
    `delete from public.profiles where id = '${ME}'`,
    // security events and the rate-limit ledger
    `insert into public.security_events (user_id, event_type) values ('${ME}', 'login')`,
    `update public.security_events set event_type = 'login'`,
    `delete from public.security_events`,
    `delete from private.rate_events`,
    `select * from private.rate_events`,
    `truncate public.checkins`,
  ];
  for (const sql of attacks) await noEffect(as(ME, () => db.query(sql)));
  assert.equal(await snapshot(), before, 'not a single row changed');
  assert.equal(cid, null);
});

test('the only client-writable column anywhere is profiles.full_name (and it stays bounded)', async () => {
  await as(ME, () => db.query(`update public.profiles set full_name = 'Me Renamed' where id = '${ME}'`));
  await refuse(as(ME, () => db.query(`update public.profiles set full_name = repeat('x', 121) where id = '${ME}'`)));
  const cols = (await db.query(`select table_name, column_name, privilege_type from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public' and privilege_type <> 'SELECT'`)).rows;
  assert.deepEqual(cols.map((c) => `${c.table_name}.${c.column_name}:${c.privilege_type}`), ['profiles.full_name:UPDATE']);
});

test('user isolation: nobody reads, updates, deletes or inserts another user\'s data (incl. via RPC)', async () => {
  for (const t of ['profiles', 'journeys', 'checkins', 'checkin_meals', 'user_achievements', 'security_events']) {
    const rows = (await as(OTHER, () => db.query(`select * from public.${t}`))).rows;
    assert.ok(rows.every((r) => (r.user_id ?? r.id) === OTHER), `${t}: OTHER sees only OTHER's rows`);
  }
  // RPCs take the owner from the JWT, never from an argument: a smuggled user_id in the payload is just ignored data
  await save(OTHER, day(-2), payload({ user_id: VICTIM, userId: VICTIM }));
  assert.equal((await one(`select count(*)::int as n from public.checkins where user_id = $1 and checkin_date = $2`, [VICTIM, day(-2)])).n, 0);
  assert.equal((await one(`select count(*)::int as n from public.checkins where user_id = $1 and checkin_date = $2`, [OTHER, day(-2)])).n, 1);
  // the signatures have no user parameter at all
  const sigs = (await db.query(`select pg_get_function_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('save_checkin','create_journey','start_next_journey','update_water_goal','set_post_goal','claim_journey_complete')`)).rows;
  assert.ok(sigs.every((s) => !/user|uid|owner/i.test(s.a)), sigs.map((s) => s.a).join(' | '));
});

// =====================================================================================================================
// legitimate achievement unlocking still works, derived from real data
// =====================================================================================================================
async function fresh(n, name = 'Ach') {
  const id = uuid(n);
  await addUser(id, name);
  await resetLimits();
  return id;
}
/** Owner-level fixture insert (arranging history only; the assertions below go through the trusted path). */
const seed = (uid, date, o = {}) => db.query(
  `insert into public.checkins (user_id, checkin_date, weight_kg, water_ml, exercise_type, exercise_minutes) values ($1,$2,$3,$4,$5,$6)`,
  [uid, date, o.w ?? null, o.water ?? 0, o.ex ? 'Gym' : null, o.ex ? 30 : null]);
/** A journey that is already over (owner-level fixture: create_journey itself refuses a journey whose last day is in the past). */
const pastJourney = async (uid, o) => {
  const r = await journey(uid, { ...o, start: day(0) });
  await db.query('update public.journeys set start_date = $2 where user_id = $1 and completed_on is null', [uid, o.start]);
  return r;
};
const ids = async (uid) => (await db.query(`select achievement_id as a from public.user_achievements where user_id = $1 order by 1`, [uid])).rows.map((r) => r.a);

test('legit unlocks: First Step, 3/7/14-day, Hydrated, Active Week, Consistent - each only when the data earns it', async () => {
  const u = await fresh(5);
  await journey(u, { start: day(-14), dur: 60, sw: 80, gw: 70, water: 2000 });
  for (let i = 14; i >= 1; i--) await seed(u, day(-i), { water: 2500, ex: i <= 4, w: 79 }); // 14 days, all hydrated, 4 workouts in the last 4
  assert.deepEqual(await ids(u), [], 'seeding alone (no trusted save today) grants nothing');
  const r = await save(u, day(0), payload({ water_ml: 2500, weight_kg: 78 }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.unlocked.map((x) => x.id), ['first', 'd3', 'd7', 'd14', 'hydrated', 'active', 'consistent']);
  assert.ok(r.unlocked.every((x) => x.on === day(0)));
  assert.deepEqual(await ids(u), ['active', 'consistent', 'd14', 'd3', 'd7', 'first', 'hydrated']);
  assert.equal((await save(u, day(0), payload())).unlocked.length, 0, 're-saving grants nothing twice');
  assert.ok(!(await ids(u)).includes('goal'), 'weight never reached 70: no goal');
});

test('legit unlocks: a small history earns only what it has (no fake d14/consistent/goal)', async () => {
  const u = await fresh(6);
  await journey(u, { start: day(-1), dur: 30, sw: 80, gw: 70 });
  const r = await save(u, day(0), payload({ weight_kg: 79 }));
  assert.deepEqual(r.unlocked.map((x) => x.id), ['first']);
});

test('legit unlock: Goal Achieved needs a real check-in weight that reaches the goal, dated to that day (loss and gain)', async () => {
  const u = await fresh(7);
  await journey(u, { start: day(-10), dur: 30, sw: 80, gw: 70 });
  await seed(u, day(-5), { w: 69.9 }); // reached 5 days ago; not yet "saved today"
  let r = await save(u, day(0), payload({ weight_kg: 72 })); // later weight went back up: the goal is still recorded on the day reached
  const g = r.unlocked.find((x) => x.id === 'goal');
  assert.equal(g.on, day(-5));
  const gain = await fresh(8);
  await journey(gain, { start: day(-3), dur: 30, sw: 50, gw: 55 });
  r = await save(gain, day(0), payload({ weight_kg: 54.9 }));
  assert.ok(!r.unlocked.some((x) => x.id === 'goal'));
  r = await save(gain, day(0), payload({ weight_kg: 55 }));
  assert.equal(r.unlocked.find((x) => x.id === 'goal').on, day(0));
});

test('legit unlock: Journey Complete comes only from claim_journey_complete, dated to the journey\'s last day', async () => {
  const u = await fresh(9);
  await journey(u, { start: day(-3), dur: 30 });
  assert.deepEqual((await as(u, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r, { ok: true, unlocked: [] });
  await journey(u, { start: day(-29), dur: 30 }); // last day = today
  assert.deepEqual((await as(u, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r, { ok: true, unlocked: [{ id: 'journey', on: day(0) }] });
  assert.deepEqual((await as(u, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r, { ok: true, unlocked: [] }, 'idempotent');
});

test('a goal/journey achievement from a FINISHED journey is replaced only when the new journey genuinely re-earns it', async () => {
  const u = await fresh(10);
  await pastJourney(u, { start: day(-40), dur: 30, sw: 80, gw: 70 }); // finished 11 days ago
  await seed(u, day(-20), { w: 69 });
  await save(u, day(0), payload({ weight_kg: 69 }));
  await as(u, () => db.query('select public.claim_journey_complete()'));
  assert.deepEqual(await ids(u), ['first', 'goal', 'journey']);
  await as(u, () => db.query(`select public.start_next_journey($1::date, 30, 69, 65, 2500, 'new_goal')`, [day(1)]));
  const old = (await db.query(`select achievement_id a, unlocked_on::text d from public.user_achievements where user_id = $1 and achievement_id in ('goal','journey') order by 1`, [u])).rows;
  assert.deepEqual(old.map((x) => x.d), [day(-20), day(-11)], 'history kept until re-earned');
  await save(u, day(0), payload({ weight_kg: 68 })); // journey 2 not yet reached: nothing replaced
  assert.equal((await one(`select unlocked_on::text d from public.user_achievements where user_id=$1 and achievement_id='goal'`, [u])).d, day(-20));
});

// ---- JS <-> SQL parity: the server derives exactly what src/domain/achievements.js says ----
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

test('parity: the SQL derivation equals the JavaScript achievement rules on 250 random histories', async () => {
  const rand = rng(20260926);
  const pick = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const today = day(0);
  for (let k = 0; k < 250; k++) {
    const u = uuid(1 + (k % 9)); // reuse ids 1..9 is wrong (they have data): use fresh users per scenario instead
    void u;
    const id = `${(0xa0000000 + k).toString(16)}-0000-4000-8000-000000000000`;
    await addUser(id, 'P');
    const start = day(-pick(0, 60));
    const duration = pick(7, 40);
    const startWeight = pick(50, 90);
    const goalWeight = rand() < 0.1 ? startWeight : startWeight + pick(-15, 15) || startWeight - 1;
    const waterGoal = pick(1, 6) * 500;
    await db.query(`insert into public.profiles (id) values ($1) on conflict do nothing`, [id]);
    await db.query(`insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml) values ($1,$2,$3,$4,$5,$6)`,
      [id, start, duration, startWeight, Math.min(300, Math.max(30, goalWeight)), waterGoal]);
    const density = 0.2 + rand() * 0.8;
    const checkins = {};
    for (let off = -70; off <= 1; off++) {
      if (rand() > density) continue;
      const date = day(off);
      const w = rand() < 0.7 ? Math.round((startWeight + (rand() * 30 - 15)) * 10) / 10 : null;
      const water = pick(0, 8) * 500;
      const ex = rand() < 0.4;
      checkins[date] = { weight: w && w >= 30 && w <= 300 ? w : null, water, exercise: ex ? { type: 'Gym', duration: 30, unit: 'minutes' } : null };
      await db.query(`insert into public.checkins (user_id, checkin_date, weight_kg, water_ml, exercise_type, exercise_minutes) values ($1,$2,$3,$4,$5,$6)`,
        [id, date, checkins[date].weight, water, ex ? 'Gym' : null, ex ? 30 : null]);
    }
    const j = (await db.query(`select goal_weight::float g from public.journeys where user_id = $1`, [id])).rows[0];
    const user = { journey: { start, duration, startWeight, goalWeight: j.g, waterGoal }, checkins, unlocked: [], unlockedDates: {} };
    const ctx = achievementContext(user, today);
    const js = ACH_DEFS.filter((a) => a.test(ctx)).map((a) => a.id).sort();
    const sql = (await db.query(`select aid, aon::text as aon from private.earned_achievements($1, $2::date)`, [id, today])).rows;
    assert.deepEqual(sql.map((r) => r.aid).sort(), js, `scenario ${k}: ${JSON.stringify(user.journey)}`);
    const g = goalAchievement(user);
    if (g) assert.equal(sql.find((r) => r.aid === 'goal').aon, g.date, `scenario ${k}: goal date`);
    if (js.includes('journey')) assert.equal(sql.find((r) => r.aid === 'journey').aon, goalDate(user.journey), `scenario ${k}: journey date`);
  }
});

// =====================================================================================================================
// PHASE 3 + 4: server-side validation and volume limits, below / at / above
// =====================================================================================================================
let saverN = 0x40;
async function saver() {
  const u = await fresh(saverN++, 'V');
  await journey(u);
  const run = (date, over, wantOk) => wantOk
    ? save(u, date, payload(over)).then((r) => assert.equal(r.ok, true))
    : assert.rejects(save(u, date, payload(over)), /invalid check-in|not authenticated/);
  run.user = u;
  return run;
}

test('validation: weight 30-300 (below / at / above), type-checked', async () => {
  const s = await saver();
  for (const [w, ok] of [[29.9, false], [30, true], [300, true], [300.1, false], ['70', false], [[70], false], [{ a: 1 }, false], [true, false], [null, true]]) {
    await s(day(0), { weight_kg: w }, ok);
  }
});

test('validation: water 0-20000 whole ml', async () => {
  const s = await saver();
  for (const [w, ok] of [[-1, false], [0, true], [19999, true], [20000, true], [20001, false], [1.5, false], ['2000', false], [1e30, false]]) {
    await s(day(0), { water_ml: w }, ok);
  }
});

test('volume: notes 3999 / 4000 / 4001 characters', async () => {
  const s = await saver();
  for (const [n, ok] of [[3999, true], [4000, true], [4001, false]]) await s(day(0), { notes: 'x'.repeat(n) }, ok);
  await s(day(0), { notes: 12345 }, false);
});

test('volume: meals per day 29 / 30 / 31 (and one water value + one workout per check-in by construction)', async () => {
  const s = await saver();
  const meals = (n) => Array.from({ length: n }, (_, i) => ({ category: ['breakfast', 'lunch', 'dinner', 'snacks'][i % 4], name: 'm' + i, notes: '', eaten_at: '10:00', position: i }));
  for (const [n, ok] of [[29, true], [30, true], [31, false]]) await s(day(0), { meals: meals(n) }, ok);
  await s(day(0), { meals: 'lots' }, false);
  await s(day(0), { meals: [{ category: 'snacks' }] }, false);
});

test('validation: meal fields (category, name 1-200, notes <=1000, time HH:MM, position 0-99)', async () => {
  const s = await saver();
  const m = (o) => [{ category: 'lunch', name: 'ok', notes: '', eaten_at: '12:00', position: 0, ...o }];
  for (const [o, ok] of [
    [{}, true], [{ category: 'brunch' }, false], [{ category: null }, false],
    [{ name: '' }, false], [{ name: 'x'.repeat(200) }, true], [{ name: 'x'.repeat(201) }, false],
    [{ notes: 'x'.repeat(1000) }, true], [{ notes: 'x'.repeat(1001) }, false],
    [{ eaten_at: '24:00' }, false], [{ eaten_at: '9:5' }, false], [{ eaten_at: 'noon' }, false], [{ eaten_at: '23:59' }, true], [{ eaten_at: '08:30:15' }, true],
    [{ position: -1 }, false], [{ position: 99 }, true], [{ position: 100 }, false], [{ position: 1.5 }, false],
  ]) await s(day(0), { meals: m(o) }, ok);
});

test('validation: mood, exercise (type <=60, minutes 0-1440, both-or-neither, unit)', async () => {
  const s = await saver();
  for (const [o, ok] of [
    [{ mood: 'great' }, true], [{ mood: null }, true], [{ mood: 'ecstatic' }, false], [{ mood: 5 }, false],
    [{ exercise_type: 'x'.repeat(60) }, true], [{ exercise_type: 'x'.repeat(61) }, false],
    [{ exercise_minutes: 0 }, true], [{ exercise_minutes: 1440 }, true], [{ exercise_minutes: 1441 }, false], [{ exercise_minutes: -1 }, false], [{ exercise_minutes: 1.5 }, false],
    [{ exercise_type: null, exercise_minutes: 30 }, false], [{ exercise_type: 'Gym', exercise_minutes: null }, false], [{ exercise_type: null, exercise_minutes: null }, true],
    [{ exercise_unit: 'hours' }, true], [{ exercise_unit: 'days' }, false], [{ exercise_unit: 3 }, false],
  ]) await s(day(0), o, ok);
});

test('validation: check-in date (not after tomorrow, not more than 400 days back, not null) and payload shape/size', async () => {
  const s = await saver();
  for (const [d, ok] of [[day(-401), false], [day(-400), true], [day(0), true], [day(1), true], [day(2), false], ['2099-01-01', false], [null, false]]) await s(d, {}, ok);
  const u = uuid(0xc); await addUser(u); await journey(u);
  for (const bad of [null, [], 'x', 5, { meals: [], notes: 'x'.repeat(100001) }]) {
    await assert.rejects(as(u, () => db.query('select public.save_checkin($1::date, $2::jsonb)', [day(0), JSON.stringify(bad)])), /invalid check-in payload|not-null|null value/i);
  }
});

test('save_checkin needs an active journey', async () => {
  const u = uuid(0xd); await addUser(u);
  await assert.rejects(save(u, day(0), payload()), /no active journey/);
  assert.equal((await one('select count(*)::int n from public.checkins where user_id = $1', [u])).n, 0);
});

test('one check-in per user per date: the same date is updated, never duplicated', async () => {
  const s = await saver();
  await s(day(0), { water_ml: 1000 }, true); await s(day(0), { water_ml: 2000 }, true); await s(day(0), { water_ml: 3000 }, true);
  assert.equal((await one('select count(*)::int n from public.checkins where user_id = $1', [s.user])).n, 1);
  assert.equal((await one('select water_ml w from public.checkins where user_id = $1', [s.user])).w, 3000);
});

test('journey validation: duration 6/7/365/366, weights, water goal, start date, null arguments', async () => {
  const u = uuid(0xe); await addUser(u); await resetLimits();
  const call = (o) => journey(u, o);
  for (const [o, ok] of [
    [{ dur: 6 }, false], [{ dur: 7 }, true], [{ dur: 365 }, true], [{ dur: 366 }, false], [{ dur: null }, false],
    [{ sw: 29.9 }, false], [{ sw: 30 }, true], [{ sw: 300 }, true], [{ sw: 300.1 }, false], [{ sw: null }, false],
    [{ gw: 29.9 }, false], [{ gw: 300.1 }, false], [{ gw: null }, false],
    [{ water: 499 }, false], [{ water: 500 }, true], [{ water: 6000 }, true], [{ water: 6001 }, false], [{ water: null }, false],
    [{ start: day(31) }, false], [{ start: day(30) }, true], [{ start: day(-3651) }, false], [{ start: day(-3650) }, false /* in range, but already over */], [{ start: day(-364), dur: 365 }, true], [{ start: day(-365), dur: 365 }, false], [{ start: null }, false],
  ]) {
    await resetLimits();
    if (ok) assert.equal((await call(o)).ok, true, JSON.stringify(o));
    else await assert.rejects(call(o), /invalid journey|null value|violates/i, JSON.stringify(o));
  }
});

test('one journey per user: create_journey edits the ACTIVE journey, it can never create a second active one', async () => {
  const u = uuid(0xe);
  await resetLimits(); await journey(u, { dur: 40 }); await resetLimits(); await journey(u, { dur: 50 });
  const rows = (await db.query('select duration_days d, completed_on from public.journeys where user_id = $1', [u])).rows;
  assert.deepEqual(rows, [{ d: 50, completed_on: null }]);
  await assert.rejects(db.query(`insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight) values ($1, current_date, 30, 60, 60)`, [u]), /unique|duplicate/i);
});

test('update_water_goal and set_post_goal validate server-side', async () => {
  const u = uuid(0xe); await resetLimits();
  const water = (ml) => as(u, () => db.query('select public.update_water_goal($1) as r', [ml]));
  for (const [ml, ok] of [[499, false], [500, true], [6000, true], [6001, false], [null, false]]) {
    if (ok) assert.equal((await water(ml)).rows[0].r.ok, true); else await assert.rejects(water(ml), /invalid water goal/);
  }
  assert.equal((await one('select water_goal_ml w from public.journeys where user_id = $1', [u])).w, 6000);
  await assert.rejects(as(u, () => db.query(`select public.set_post_goal('maintain')`)), /goal not reached/);
});

test('start_next_journey validates mode, parameters and the start window server-side', async () => {
  const u = uuid(0xf); await addUser(u); await resetLimits();
  await pastJourney(u, { start: day(-40), dur: 30, sw: 80, gw: 70 }); // ended 11 days ago
  const next = (start, dur = 30, mode = 'journal', water = 2500) => as(u, () => db.query(`select public.start_next_journey($1::date, $2, 70, 65, $3, $4) as r`, [start, dur, water, mode]));
  await assert.rejects(next(day(-11)), /after the previous one ends/);
  await assert.rejects(next(day(31)), /out of range/);
  await assert.rejects(next(day(0), 6), /invalid journey/);
  await assert.rejects(next(day(0), 30, 'journal', 100), /invalid journey/);
  await assert.rejects(next(day(0), 30, 'nope'), /invalid mode/);
  assert.equal((await next(day(0))).rows[0].r.ok, true);
  assert.equal((await one('select count(*)::int n from public.journeys where user_id = $1 and completed_on is null', [u])).n, 1);
});

// =====================================================================================================================
// PHASE 5: per-user rate limiting
// =====================================================================================================================
test('rate limit: save_checkin allows 30 per 5 minutes, then returns a clean rate_limited result (no data written, no leak)', async () => {
  const u = await fresh(0x11, 'RL'); await journey(u);
  for (let i = 0; i < 30; i++) assert.equal((await save(u, day(0), payload({ water_ml: 1000 + i }))).ok, true, `call ${i + 1}`);
  const blocked = await save(u, day(0), payload({ water_ml: 9999 }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'rate_limited');
  assert.ok(blocked.retry_after >= 1 && blocked.retry_after <= 300, `retry_after=${blocked.retry_after}`);
  assert.deepEqual(Object.keys(blocked).sort(), ['code', 'ok', 'retry_after'], 'nothing internal in the result');
  assert.equal((await one('select water_ml w from public.checkins where user_id = $1', [u])).w, 1029, 'the blocked save wrote nothing');
  // blocked calls are not recorded (a blocked client is never locked out longer than the window)
  assert.equal((await one(`select count(*)::int n from private.rate_events where user_id = $1 and bucket = 'save_checkin'`, [u])).n, 30);
  // another user is unaffected
  assert.equal((await save(OTHER, day(0), payload())).ok, true);
});

test('rate limit is a SLIDING window: it frees up as old calls age out', async () => {
  const u = uuid(0x11);
  await db.query(`update private.rate_events set at = now() - interval '6 minutes' where user_id = $1 and bucket = 'save_checkin' and ctid in (select ctid from private.rate_events where user_id = $1 order by at limit 10)`, [u]);
  assert.equal((await save(u, day(0), payload())).ok, true);
  assert.equal((await save(u, day(0), payload())).ok, true);
});

test('rate limit: the daily cap (400) holds even when the 5-minute window is clear', async () => {
  const u = await fresh(0x12, 'RL2'); await journey(u);
  await db.query(`insert into private.rate_events (user_id, bucket, at) select $1, 'save_checkin', now() - interval '1 hour' - (g || ' seconds')::interval from generate_series(1, 400) g`, [u]);
  const r = await save(u, day(0), payload());
  assert.equal(r.code, 'rate_limited');
  assert.ok(r.retry_after > 60);
  await db.query(`update private.rate_events set at = now() - interval '25 hours' where user_id = $1`, [u]);
  assert.equal((await save(u, day(0), payload())).ok, true);
});

test('rate limit: create_journey 10/hour, start_next_journey 5/hour, update_water_goal + set_post_goal 20/hour (shared), claim 20/hour', async () => {
  const u = await fresh(0x13, 'RL3');
  for (let i = 0; i < 10; i++) assert.equal((await journey(u, { dur: 30 + i })).ok, true);
  assert.equal((await journey(u)).code, 'rate_limited');
  for (let i = 0; i < 20; i++) assert.equal((await as(u, () => db.query('select public.update_water_goal(2500) as r'))).rows[0].r.ok, true);
  assert.equal((await as(u, () => db.query('select public.update_water_goal(2500) as r'))).rows[0].r.code, 'rate_limited');
  for (let i = 0; i < 20; i++) assert.equal((await as(u, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r.ok, true);
  assert.equal((await as(u, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r.code, 'rate_limited');
  const v = await fresh(0x14, 'RL4');
  await pastJourney(v, { start: day(-100), dur: 30, sw: 80, gw: 70 });
  const nxt = () => as(v, () => db.query(`select public.start_next_journey(current_date, 30, 70, 65, 2500, 'journal') as r`));
  // a journey that just started is not complete, so the calls raise instead of being counted; seed the ledger to test the cap itself
  await db.query(`insert into private.rate_events (user_id, bucket) select $1, 'start_next_journey' from generate_series(1, 5)`, [v]);
  assert.equal((await nxt()).rows[0].r.code, 'rate_limited');
});

test('rate limit hits are logged (deduplicated) for the user; repeated abuse raises suspicious_activity', async () => {
  const u = uuid(0x11);
  const ev = (await as(u, () => db.query(`select event_type, details from public.security_events order by id`))).rows;
  assert.ok(ev.some((e) => e.event_type === 'rate_limited' && e.details.bucket === 'save_checkin'));
  assert.equal(ev.filter((e) => e.event_type === 'rate_limited').length, 1, 'many blocked calls in one minute -> one event');
  // ten separate minutes of hammering -> suspicious_activity, once per day
  await db.query(`insert into public.security_events (user_id, event_type, details, created_at)
                  select $1, 'rate_limited', '{"bucket":"save_checkin"}', now() - (g || ' minutes')::interval from generate_series(2, 12) g`, [u]);
  await db.query(`delete from private.rate_events where user_id = $1`, [u]);
  await db.query(`insert into private.rate_events (user_id, bucket) select $1, 'save_checkin' from generate_series(1, 30)`, [u]);
  await db.query(`update public.security_events set created_at = now() - interval '2 minutes' where user_id = $1 and event_type = 'rate_limited' and id = (select max(id) from public.security_events where user_id = $1 and event_type = 'rate_limited')`, [u]);
  await save(u, day(0), payload());
  assert.equal((await one(`select count(*)::int n from public.security_events where user_id = $1 and event_type = 'suspicious_activity'`, [u])).n, 1);
  await save(u, day(0), payload());
  assert.equal((await one(`select count(*)::int n from public.security_events where user_id = $1 and event_type = 'suspicious_activity'`, [u])).n, 1, 'deduplicated');
});

// =====================================================================================================================
// PHASE 8: security events
// =====================================================================================================================
test('security events: signup / login / password change / reset request / MFA / session revocation are recorded', async () => {
  const u = uuid(0x21); await addUser(u, 'Ev');
  await db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [u]);
  await db.query(`update auth.users set encrypted_password = 'x' where id = $1`, [u]);
  await db.query(`update auth.users set recovery_sent_at = now() where id = $1`, [u]);
  const f = (await db.query(`insert into auth.mfa_factors (user_id, status) values ($1, 'unverified') returning id`, [u])).rows[0].id;
  await db.query(`update auth.mfa_factors set status = 'verified' where id = $1`, [f]);
  await db.query(`delete from auth.mfa_factors where id = $1`, [f]);
  await db.query(`insert into auth.sessions (user_id) values ($1), ($1)`, [u]);
  await db.query(`delete from auth.sessions where user_id = $1`, [u]);
  const types = (await db.query(`select event_type from public.security_events where user_id = $1 order by id`, [u])).rows.map((r) => r.event_type);
  assert.deepEqual(types, ['signup', 'login', 'password_change', 'password_reset_request', 'mfa_enabled', 'mfa_disabled', 'session_revoked']);
});

test('security events: users read only their own; nobody writes; no secret-bearing columns; indexed', async () => {
  const u = uuid(0x21);
  const mine = (await as(u, () => db.query('select * from public.security_events'))).rows;
  assert.ok(mine.length >= 7 && mine.every((r) => r.user_id === u));
  assert.ok((await as(ME, () => db.query('select * from public.security_events'))).rows.every((r) => r.user_id === ME));
  await noEffect(as(u, () => db.query(`insert into public.security_events (user_id, event_type) values ('${u}', 'login')`)));
  await noEffect(as(u, () => db.query(`update public.security_events set event_type = 'login'`)));
  await noEffect(as(u, () => db.query(`delete from public.security_events`)));
  await refuse(as(null, () => db.query('select * from public.security_events')));
  const cols = (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='security_events'`)).rows.map((r) => r.column_name).sort();
  assert.deepEqual(cols, ['created_at', 'details', 'event_type', 'id', 'user_id']);
  await assert.rejects(db.query(`insert into public.security_events (user_id, event_type) values (null, 'password_dump')`), /violates/);
  await assert.rejects(db.query(`insert into public.security_events (user_id, event_type, details) values (null, 'login', '{"a":"${'x'.repeat(2000)}"}')`), /violates/);
  const idx = (await db.query(`select indexname from pg_indexes where tablename = 'security_events'`)).rows.map((r) => r.indexname);
  assert.ok(idx.includes('security_events_user_idx') && idx.includes('security_events_type_idx'));
});

test('security events: an auditing failure can never block sign-in / MFA / session changes', async () => {
  const u = uuid(0x22); await addUser(u, 'Ev2');
  await db.exec('alter table public.security_events rename to security_events_x');
  try {
    await db.query(`update auth.users set last_sign_in_at = now(), encrypted_password = 'y', recovery_sent_at = now() where id = $1`, [u]);
    await db.query(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [u]);
    await db.query(`insert into auth.sessions (user_id) values ($1)`, [u]);
    await db.query(`delete from auth.sessions where user_id = $1`, [u]);
  } finally { await db.exec('alter table public.security_events_x rename to security_events'); }
  await db.query(`delete from auth.mfa_factors where user_id = $1`, [u]);
});

test('security events: a signup spike is flagged as suspicious_activity (logging only, never a block)', async () => {
  await db.query(`insert into public.security_events (user_id, event_type) select null, 'signup' from generate_series(1, 30)`);
  await addUser(uuid(0x23), 'Spike'); // signup still succeeds
  assert.ok((await one(`select count(*)::int n from public.security_events where event_type = 'suspicious_activity' and details->>'reason' = 'signup_spike_10m'`)).n >= 1);
});

// =====================================================================================================================
// PHASE 9: MFA enforcement for users who enrolled (creator opt-in)
// =====================================================================================================================
test('MFA: a user with a VERIFIED factor is blocked on aal1 (reads and RPCs) and allowed on aal2; others unaffected', async () => {
  await journey(MFA_USER);
  await save(MFA_USER, day(0), payload());
  await db.query(`insert into auth.mfa_factors (user_id, status) values ($1, 'unverified')`, [MFA_USER]);
  assert.equal((await as(MFA_USER, () => db.query('select * from public.checkins'), { aal: 'aal1' })).rows.length, 1, 'an unverified factor blocks nothing');
  await db.query(`update auth.mfa_factors set status = 'verified' where user_id = $1`, [MFA_USER]);
  for (const t of ['profiles', 'journeys', 'checkins', 'checkin_meals', 'user_achievements', 'security_events']) {
    assert.equal((await as(MFA_USER, () => db.query(`select * from public.${t}`), { aal: 'aal1' })).rows.length, 0, `${t} hidden on aal1`);
    assert.ok((await as(MFA_USER, () => db.query(`select * from public.${t}`), { aal: 'aal2' })).rows.length >= 1, `${t} visible on aal2`);
  }
  await assert.rejects(as(MFA_USER, () => db.query('select public.save_checkin($1::date, $2::jsonb)', [day(0), JSON.stringify(payload())]), { aal: 'aal1' }), /mfa_required/);
  await assert.rejects(as(MFA_USER, () => db.query('select public.update_water_goal(2500)'), { aal: 'aal1' }), /mfa_required/);
  await assert.rejects(as(MFA_USER, () => db.query('select public.claim_journey_complete()'), { aal: 'aal1' }), /mfa_required/);
  assert.equal((await as(MFA_USER, () => db.query('select public.update_water_goal(2600) as r'), { aal: 'aal2' })).rows[0].r.ok, true);
  assert.equal((await as(ME, () => db.query('select * from public.journeys'))).rows.length, 1, 'a user without MFA is unaffected on aal1 / no claim');
});

// =====================================================================================================================
// PHASE 14 + 15: function and grant inventory, policy audit
// =====================================================================================================================
const EXPECTED_AUTHENTICATED_EXECUTE = [
  'private.aal_ok()',
  'public.claim_journey_complete()',
  'public.create_journey(date,integer,numeric,numeric,integer)',
  'public.save_checkin(date,jsonb)',
  'public.set_post_goal(text,numeric)',
  'public.start_next_journey(date,integer,numeric,numeric,integer,text)',
  'public.update_water_goal(integer)',
];

test('function inventory: search_path is pinned, PUBLIC/anon can execute nothing, authenticated only the audited RPCs', async () => {
  const fns = (await db.query(`
    select n.nspname || '.' || p.proname || '(' || array_to_string(array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t), ',') || ')' as sig, p.prosecdef as definer,
           coalesce(p.proconfig, '{}') as cfg,
           has_function_privilege('anon', p.oid, 'execute') as anon_x,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f' order by 1`)).rows;
  assert.ok(fns.length >= 15, `inventory looks complete (${fns.length})`);
  for (const f of fns) {
    assert.ok(f.cfg.some((c) => /^search_path=("")?$/.test(c) || c === 'search_path=""' || c === "search_path=''" || c === 'search_path='), `${f.sig}: search_path must be pinned to empty (${f.cfg})`);
    assert.equal(f.public_x, false, `${f.sig}: PUBLIC must not have EXECUTE`);
    assert.equal(f.anon_x, false, `${f.sig}: anon must not have EXECUTE`);
  }
  assert.deepEqual(fns.filter((f) => f.auth_x).map((f) => f.sig).sort(), [...EXPECTED_AUTHENTICATED_EXECUTE].sort(), 'authenticated may execute exactly the audited functions');
  // every public RPC is SECURITY DEFINER on purpose (the browser has no write grants); helpers are never reachable from the API
  const definers = fns.filter((f) => f.definer).map((f) => f.sig);
  for (const sig of EXPECTED_AUTHENTICATED_EXECUTE.filter((s) => s.startsWith('public.'))) assert.ok(definers.includes(sig), `${sig} is a definer RPC`);
  assert.equal(fns.filter((f) => f.sig.startsWith('private.') && f.auth_x).length, 1, 'only private.aal_ok is executable by authenticated');
});

test('table privileges: authenticated has SELECT only (plus profiles.full_name UPDATE); anon has nothing; every table has RLS', async () => {
  const t = (await db.query(`select c.relname, c.relrowsecurity rls, n.nspname,
      has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger') any_anon,
      has_table_privilege('authenticated', c.oid, 'insert') ins, has_table_privilege('authenticated', c.oid, 'delete') del,
      has_table_privilege('authenticated', c.oid, 'update') upd, has_table_privilege('authenticated', c.oid, 'truncate') trunc,
      has_table_privilege('authenticated', c.oid, 'select') sel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relkind = 'r' order by 1`)).rows;
  assert.deepEqual(t.filter((x) => x.nspname === 'public').map((x) => x.relname), ['checkin_meals', 'checkins', 'journeys', 'profiles', 'security_events', 'user_achievements']);
  for (const x of t) {
    assert.equal(x.rls, true, `${x.nspname}.${x.relname} has RLS`);
    assert.equal(x.any_anon, false, `${x.relname}: anon has no privilege`);
    assert.equal(x.ins || x.del || x.trunc, false, `${x.relname}: authenticated cannot insert/delete/truncate`);
    assert.equal(x.upd, x.relname === 'profiles' ? false : false, `${x.relname}: no table-level UPDATE`);
    assert.equal(x.sel, x.nspname === 'public', `${x.relname}: SELECT only on public tables`);
  }
});

test('policies: scoped to auth.uid(); every UPDATE policy has USING and WITH CHECK; no auth.role(), no user_metadata, no PUBLIC role', async () => {
  const pol = (await db.query(`select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`)).rows;
  assert.ok(pol.length >= 12);
  for (const p of pol) {
    const text = `${p.qual} ${p.with_check}`;
    assert.ok(!/auth\.role\(\)|user_metadata|raw_user_meta/i.test(text), `${p.tablename}.${p.policyname}: no role/metadata-based authorization`);
    assert.deepEqual(p.roles, ['authenticated'], `${p.tablename}.${p.policyname}: only the authenticated role`);
    if (p.cmd === 'UPDATE') assert.ok(p.qual && p.with_check, `${p.tablename}.${p.policyname}: UPDATE needs USING and WITH CHECK`);
    if (p.permissive === 'PERMISSIVE') assert.match(text, /auth\.uid\(\)/, `${p.tablename}.${p.policyname}: scoped to auth.uid()`);
    assert.notEqual(p.cmd, 'INSERT', `${p.tablename}.${p.policyname}: no INSERT policies at all`);
    assert.notEqual(p.cmd, 'DELETE', `${p.tablename}.${p.policyname}: no DELETE policies at all`);
  }
  assert.deepEqual(pol.filter((p) => p.cmd === 'UPDATE').map((p) => p.tablename), ['profiles']);
});

test('no secrets or credentials are stored anywhere in the application schema', async () => {
  const cols = (await db.query(`select table_schema, table_name, column_name from information_schema.columns
    where table_schema in ('public','private') and column_name ~* '(pass|secret|token|apikey|api_key|captcha|service_role)'`)).rows;
  assert.deepEqual(cols, []);
});

test('anon cannot call any RPC or read any table', async () => {
  for (const sql of [
    `select public.save_checkin(current_date, '{}'::jsonb)`, `select public.create_journey(current_date, 30, 70, 65, 2500)`,
    `select public.start_next_journey(current_date, 30, 70, 65, 2500, 'journal')`, `select public.update_water_goal(2500)`,
    `select public.set_post_goal('maintain')`, `select public.claim_journey_complete()`,
    `select private.aal_ok()`, `select private.grant_achievements('${ME}', current_date, array['goal'])`, `select private.rate_check('${ME}', 'x', 1, '1 s', 1, '1 s')`,
    'select * from public.profiles', 'select * from public.journeys', 'select * from public.checkins',
  ]) await assert.rejects(as(null, () => db.query(sql)), /permission denied/i, sql);
});

test('authenticated cannot call the privileged helpers directly (grant achievements, log events, bypass the rate limiter)', async () => {
  for (const sql of [
    `select private.grant_achievements('${ME}', current_date, array['goal','d14','consistent'])`,
    `select private.earned_achievements('${ME}', current_date)`,
    `select private.log_security_event('${ME}', 'login')`,
    `select private.rate_check('${ME}', 'save_checkin', 1000, '1 hour', 1000, '1 day')`,
    `select private.on_auth_user_update()`,
  ]) await assert.rejects(as(ME, () => db.query(sql)), /permission denied/i, sql);
  assert.ok(!(await ids(ME)).includes('goal'));
});
