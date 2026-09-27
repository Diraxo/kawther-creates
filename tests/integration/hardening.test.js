// The production-migration review fixes, proven against real Postgres (PGlite) on a database provisioned BEFORE the hardening
// (tests/fixtures/schema.pre-hardening.sql): transaction safety, prerequisite guards, deterministic policies, achievement
// HISTORY preservation vs forgery, the one-time cleanup, the aal_ok smoke test, auth-trigger isolation, journey date protection.
// The hosted project is NOT touched by anything here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, harness, read, uuid } from './helpers.js';

const CORE = 'supabase/migrations/2026-09-30_security_hardening.sql';
const AUDIT = 'supabase/migrations/2026-09-30b_auth_audit_triggers.sql';
const FIXTURE = 'tests/fixtures/schema.pre-hardening.sql';

const legacy = async () => { const db = await makeDb([FIXTURE]); return { db, h: harness(db) }; };
/** Runs a migration file that is expected to fail; leaves the session clean (a failed transaction stays open until rolled back). */
const failing = async (db, file, pattern) => {
  await assert.rejects(db.exec(read(file)), pattern);
  await db.exec('rollback');
};
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0];
const SIX = `('profiles','journeys','checkins','checkin_meals','user_achievements','security_events')`;
const policies = async (db) => (await db.query(`select tablename t, policyname p, permissive perm, cmd from pg_policies where schemaname = 'public' and tablename in ${SIX} order by 1, 2`)).rows;

// ---------------------------------------------------------------------------------------------------------------------
// A rich legacy database: a finished journey 1 with every achievement legitimately earned, an active journey 2 whose
// behaviour no longer satisfies journey 1's conditions, a forger, and a mixed user.
// ---------------------------------------------------------------------------------------------------------------------
const [U, F, M, L] = [uuid(0x11), uuid(0x12), uuid(0x13), uuid(0x14)];
async function seedHistory(db) {
  for (const [id, n] of [[U, 'Journey Two'], [F, 'Forger'], [M, 'Mixed'], [L, 'Later']]) {
    await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${n.slice(0, 3)}@x.test', '{"full_name":"${n}"}')`);
  }
  await db.exec(`
    -- journey 1: 30 days, every day checked in, weight 80 -> 70 by day 20 then back UP to 72, water 2100 (goal was 2000, since raised to 3000)
    insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml, completed_on)
      values ('${U}', current_date - 100, 30, 80, 70, 3000, current_date - 71);
    -- journey 2 (active): almost nothing logged, weight above where journey 1 ended, water far below the (raised) goal
    insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml)
      values ('${U}', current_date - 5, 60, 72, 60, 3000);
    insert into public.checkins (user_id, checkin_date, weight_kg, water_ml, exercise_type, exercise_minutes)
      select '${U}', current_date - 100 + i, case when i <= 20 then 80 - i * 0.5 else 72 end, 2100, 'Gym', 30 from generate_series(0, 29) i;
    insert into public.checkins (user_id, checkin_date, weight_kg, water_ml) values ('${U}', current_date, 71, 500);
    insert into public.checkin_meals (checkin_id, user_id, category, name, eaten_at)
      select id, user_id, 'breakfast', 'Eggs', '08:00' from public.checkins where user_id = '${U}' and checkin_date in (current_date, current_date - 100);
    -- what the OLD client wrote, each dated the day it was earned in journey 1
    insert into public.user_achievements (user_id, achievement_id, unlocked_on) values
      ('${U}', 'first', current_date - 100), ('${U}', 'd3', current_date - 98), ('${U}', 'd7', current_date - 94),
      ('${U}', 'd14', current_date - 87), ('${U}', 'hydrated', current_date - 94), ('${U}', 'active', current_date - 97),
      ('${U}', 'consistent', current_date - 94), ('${U}', 'goal', current_date - 80), ('${U}', 'journey', current_date - 71);

    -- the forger: a fresh journey, ONE check-in, and every big achievement written straight into the table
    insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml)
      values ('${F}', current_date, 30, 70, 60, 2500);
    insert into public.checkins (user_id, checkin_date, weight_kg, water_ml) values ('${F}', current_date, 69, 2600);
    insert into public.user_achievements (user_id, achievement_id, unlocked_on)
      select '${F}', a, current_date from unnest(array['d14','hydrated','consistent','goal','journey']) a;

    -- mixed: one real check-in earned 'first'; the extra 'd7' is forged
    insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml)
      values ('${M}', current_date, 30, 70, 60, 2500);
    insert into public.checkins (user_id, checkin_date, water_ml) values ('${M}', current_date, 2600);
    insert into public.user_achievements (user_id, achievement_id, unlocked_on) values ('${M}', 'first', current_date), ('${M}', 'd7', current_date);
  `);
}
const achievementRows = async (db, table = 'public.user_achievements') =>
  (await db.query(`select user_id::text u, achievement_id a, unlocked_on::text d from ${table} order by 1, 2`)).rows;
const snapshot = async (db) => {
  const out = {};
  for (const t of ['auth.users', 'public.profiles', 'public.journeys', 'public.checkins', 'public.checkin_meals']) {
    out[t] = await one(db, `select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h, count(*)::int as n from ${t} x`);
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
test('TRANSACTION: the core migration is one transaction with a lock timeout; nothing is left applied by a run, and the setting is transaction-local', async () => {
  const sql = read(CORE).replaceAll('\r\n', '\n');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(code, /^\s*begin;\s*\nset local lock_timeout = '5s';/, 'begin + set local lock_timeout come first');
  assert.match(code.trimEnd(), /commit;$/, 'commit comes last');
  assert.equal((code.match(/^\s*begin;/gm) || []).length, 1);
  assert.doesNotMatch(code, /concurrently|^\s*vacuum/im, 'nothing that cannot run inside a transaction');
  assert.doesNotMatch(sql, /safe to re-run/i, 'no claim of unlimited re-runs');
  const { db } = await legacy();
  await db.exec(sql);
  assert.equal((await one(db, `select current_setting('lock_timeout') as t`)).t, '0', 'set local: the timeout did not leak out of the transaction');
  assert.equal((await one(db, `select count(*)::int as n from pg_stat_activity where state like 'idle in transaction%'`)).n, 0);
});

test('TRANSACTION: a failure part-way (after the cleanup and every revoke) rolls EVERYTHING back - no partial hardening', async () => {
  const { db } = await legacy();
  await seedHistory(db);
  // make the smoke test fail at the very end of the migration: reading auth.mfa_factors is refused at run time
  await db.exec(`alter table auth.mfa_factors rename to mfa_factors_real; insert into auth.mfa_factors_real (user_id, status) values ('${uuid(0x99)}', 'verified');
    select set_config('request.jwt.claim.sub', '${uuid(0x99)}', false); -- a uid with a verified factor, so aal_ok really reads the table
    create function auth.boom() returns boolean language plpgsql as $$ begin raise exception 'permission denied for table mfa_factors' using errcode = '42501'; end $$;
    create view auth.mfa_factors as select * from auth.mfa_factors_real where auth.boom();`);
  const before = { ach: await achievementRows(db), pol: await policies(db) };
  await failing(db, CORE, /private\.aal_ok\(\) cannot execute/);
  assert.equal((await one(db, `select to_regnamespace('private') is null as gone`)).gone, true, 'the private schema was rolled back');
  assert.deepEqual(await achievementRows(db), before.ach, 'the cleanup was rolled back: forged rows are still there, nothing quarantined');
  assert.deepEqual(await policies(db), before.pol, 'policies untouched');
  const g = await one(db, `select has_table_privilege('authenticated', 'public.user_achievements', 'insert') as i, to_regprocedure('public.update_water_goal(int)') is null as nofn`);
  assert.deepEqual(g, { i: true, nofn: true }, 'no revoke and no new RPC survived: the database is exactly as it was');
});

test('MFA/AAL2 SMOKE TEST: an aal_ok() that cannot run aborts the migration with a clear error (never swallowed, never weakened)', async () => {
  const { db } = await legacy();
  await db.exec(`alter table auth.mfa_factors rename to mfa_factors_real; insert into auth.mfa_factors_real (user_id, status) values ('${uuid(0x99)}', 'verified');
    select set_config('request.jwt.claim.sub', '${uuid(0x99)}', false); -- a uid with a verified factor, so aal_ok really reads the table
    create function auth.boom() returns boolean language plpgsql as $$ begin raise exception 'permission denied for table mfa_factors' using errcode = '42501'; end $$;
    create view auth.mfa_factors as select * from auth.mfa_factors_real where auth.boom();`);
  await assert.rejects(db.exec(read(CORE)), (e) => /private\.aal_ok\(\) cannot execute/.test(e.message) && /42501/.test(e.message) && /Nothing was applied/.test(e.message));
  await db.exec('rollback');
  const sql = read(CORE);
  assert.match(sql, /select private\.aal_ok\(\) into ok;/, 'the smoke test executes the function');
  assert.doesNotMatch(sql.slice(sql.indexOf('-- ---------- smoke test')), /exception when others then\s+null/, 'not swallowed');
  // and on a healthy database it passes and the function is unchanged (still fail-closed, still reads verified factors)
  const ok = await legacy();
  await ok.db.exec(read(CORE));
  assert.equal((await one(ok.db, `select private.aal_ok() as v`)).v, true);
});

test('PREREQUISITE GUARDS: each missing migration 26-29 object aborts up front with a message naming it, changing nothing', async () => {
  const cases = [
    ['completed_on', `alter table public.journeys drop column completed_on cascade`, /column public\.journeys\.completed_on/],
    ['post_goal_mode', `alter table public.journeys drop column post_goal_mode cascade`, /column public\.journeys\.post_goal_mode/],
    ['next_goal_weight', `alter table public.journeys drop column next_goal_weight cascade`, /column public\.journeys\.next_goal_weight/],
    ['exercise_unit', `alter table public.checkins drop column exercise_unit cascade`, /column public\.checkins\.exercise_unit/],
    ['one-active index', `drop index public.journeys_one_active_per_user`, /journeys_one_active_per_user/],
  ];
  for (const [name, breakIt, pattern] of cases) {
    const { db } = await legacy();
    await db.exec(breakIt);
    await failing(db, CORE, new RegExp(`missing prerequisites: .*${pattern.source}`));
    assert.equal((await one(db, `select to_regnamespace('private') is null as gone`)).gone, true, `${name}: nothing was created`);
    assert.equal((await one(db, `select has_table_privilege('authenticated', 'public.journeys', 'update') as u`)).u, true, `${name}: nothing was revoked`);
  }
  // all four columns missing: every one is named in ONE message
  const { db } = await legacy();
  await db.exec(`alter table public.journeys drop column completed_on cascade; alter table public.journeys drop column post_goal_mode cascade;
                 alter table public.journeys drop column next_goal_weight cascade; alter table public.checkins drop column exercise_unit cascade`);
  await assert.rejects(db.exec(read(CORE)), (e) => ['completed_on', 'post_goal_mode', 'next_goal_weight', 'exercise_unit'].every((c) => e.message.includes(c)));
  await db.exec('rollback');
});

test('RLS POLICY CLEANUP: an unexpected permissive (or restrictive) policy on the six tables cannot survive; unrelated tables are untouched', async () => {
  const { db, h } = await legacy();
  await h.addUser(uuid(1)); await h.addUser(uuid(2));
  await db.exec(`
    create policy "dashboard open"    on public.user_achievements for all    to public        using (true) with check (true);
    create policy "tmp experiment"    on public.journeys          for insert to authenticated with check (true);
    create policy "checkins anyone"   on public.checkins          for select to anon          using (true);
    create policy "meals wide"        on public.checkin_meals     for all    to authenticated using (true) with check (true);
    create policy "profiles junk"     on public.profiles          as restrictive for update to authenticated using (true);
    create table public.unrelated_notes (id int, owner uuid);
    alter table public.unrelated_notes enable row level security;
    create policy "notes own" on public.unrelated_notes for all to authenticated using (owner = auth.uid());`);
  assert.ok((await policies(db)).some((p) => p.p === 'dashboard open'), 'fixture: the stray policy is there');
  await db.exec(read(CORE));
  const fresh = await makeDb(['supabase/schema.sql']);
  assert.deepEqual(await policies(db), await policies(fresh), 'exactly the intended policies, identical to a fresh schema.sql');
  assert.ok(!(await policies(db)).some((p) => /dashboard|experiment|anyone|wide|junk|open/.test(p.p)));
  assert.deepEqual((await db.query(`select policyname from pg_policies where tablename = 'unrelated_notes'`)).rows, [{ policyname: 'notes own' }], 'unrelated table policy kept');
  // even if a grant regressed later, no permissive write policy exists to let a write through
  await db.exec(`grant insert, update, delete on public.user_achievements, public.journeys, public.checkin_meals to authenticated`);
  for (const sql of [
    `insert into public.user_achievements values ('${uuid(1)}', 'goal', current_date)`,
    `insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight) values ('${uuid(1)}', current_date, 30, 60, 50)`,
  ]) await assert.rejects(h.as(uuid(1), () => db.query(sql)), /row-level security/);
});

test('ACHIEVEMENT HISTORY / JOURNEY-2 REGRESSION: journey 1 history survives the cleanup untouched; forged rows are quarantined; nothing else changes', async () => {
  const { db, h } = await legacy();
  await seedHistory(db);
  const before = await snapshot(db);
  const ach0 = await achievementRows(db);
  assert.equal(ach0.filter((r) => r.u === U).length, 9);
  await db.exec(read(CORE));

  const kept = await achievementRows(db);
  const quarantined = await achievementRows(db, 'private.achievements_quarantine');
  // journey 1's nine achievements: present, same dates, none quarantined
  assert.deepEqual(kept.filter((r) => r.u === U), ach0.filter((r) => r.u === U), 'JOURNEY-2 REGRESSION: every journey-1 achievement stays, with its original date');
  assert.deepEqual(quarantined.filter((r) => r.u === U), [], 'none of them was quarantined');
  for (const id of ['journey', 'goal', 'consistent', 'hydrated']) assert.ok(kept.some((r) => r.u === U && r.a === id), `${id} (historical) stays`);
  // the forger and the forged extra are quarantined, the mixed user keeps only what is real
  assert.deepEqual(quarantined.filter((r) => r.u === F).map((r) => r.a).sort(), ['consistent', 'd14', 'goal', 'hydrated', 'journey']);
  assert.deepEqual(kept.filter((r) => r.u === F), []);
  assert.deepEqual(kept.filter((r) => r.u === M).map((r) => r.a), ['first']);
  assert.deepEqual(quarantined.filter((r) => r.u === M).map((r) => r.a), ['d7']);
  assert.equal(kept.length + quarantined.length, ach0.length, 'every legacy row is either kept or quarantined - none deleted');
  // hardening changed no user data
  assert.deepEqual(await snapshot(db), before, 'journeys, check-ins, meals, profiles and auth.users are byte-for-byte unchanged');

  // journey 2 keeps running: saving today's check-in (which does NOT satisfy journey 1's conditions) revokes nothing
  const r = await h.save(U, h.day(0), h.payload({ weight_kg: 71, water_ml: 500, exercise_type: null, exercise_minutes: null }));
  assert.equal(r.ok, true);
  assert.deepEqual(await h.as(U, async () => (await db.query(`select user_id::text u, achievement_id a, unlocked_on::text d from public.user_achievements order by 2`)).rows),
    ach0.filter((r2) => r2.u === U).sort((x, y) => (x.a < y.a ? -1 : 1)), 'still exactly journey 1\'s nine, dates intact');
  assert.deepEqual((await h.as(U, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r, { ok: true, unlocked: [] });
});

test('GOAL / CONSISTENT / HYDRATED HISTORY: each is sticky - it does not depend on today\'s weight, streak or water goal', async () => {
  const { db } = await legacy();
  await seedHistory(db);
  // "later behaviour" made as bad as possible: weight above the old goal, water goal raised again, journey-2 check-ins gone
  await db.exec(`update public.journeys set water_goal_ml = 6000 where user_id = '${U}'; update public.checkins set weight_kg = 79, water_ml = 700 where user_id = '${U}' and checkin_date >= current_date - 70;`);
  await db.exec(read(CORE));
  const kept = (await achievementRows(db)).filter((r) => r.u === U).map((r) => r.a).sort();
  assert.deepEqual(kept, ['active', 'consistent', 'd14', 'd3', 'd7', 'first', 'goal', 'hydrated', 'journey']);
  assert.equal((await achievementRows(db, 'private.achievements_quarantine')).filter((r) => r.u === U).length, 0);
});

test('ACHIEVEMENT FORGERY vs LEGITIMATE: the browser cannot write or forge; a server-derived achievement is a different thing and remains', async () => {
  const { db, h } = await legacy();
  await seedHistory(db);
  await db.exec(read(CORE));
  // forgery attempts by the browser all fail (direct write privilege is gone; there is no permissive policy either)
  for (const sql of [
    `insert into public.user_achievements values ('${F}', 'goal', current_date)`,
    `update public.user_achievements set unlocked_on = current_date where user_id = '${F}'`,
    `delete from public.user_achievements where user_id = '${U}'`,
    `insert into public.user_achievements values ('${U}', 'hydrated', current_date) on conflict do nothing`,
  ]) await assert.rejects(h.as(F, () => db.query(sql)), /permission denied|row-level security/);
  // forger asks the server for the big ones: nothing is granted
  assert.deepEqual((await h.as(F, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r, { ok: true, unlocked: [] });
  // a legitimate server-derived achievement: L checks in through the RPC and earns 'first'; a later run of the migration keeps it
  await h.journey(L, { start: h.day(0), dur: 30 });
  const r = await h.save(L, h.day(0), h.payload());
  assert.deepEqual(r.unlocked.map((u) => u.id), ['first']);
  await db.exec(read(CORE));
  assert.deepEqual((await achievementRows(db)).filter((x) => x.u === L).map((x) => x.a), ['first']);
  assert.equal((await achievementRows(db, 'private.achievements_quarantine')).filter((x) => x.u === L).length, 0);
});

test('ONE-TIME CLEANUP: the marker stops a second run quarantining; a database that already ran an earlier revision is not cleaned again', async () => {
  const { db } = await legacy();
  await seedHistory(db);
  await db.exec(read(CORE));
  assert.equal((await one(db, `select count(*)::int as n from private.schema_markers where name = 'legacy_achievement_cleanup'`)).n, 1);
  const q1 = (await achievementRows(db, 'private.achievements_quarantine')).length;
  await db.exec(`insert into public.user_achievements values ('${F}', 'goal', current_date)`); // would be quarantined by a repeat cleanup
  await db.exec(read(CORE));
  await db.exec(read(CORE));
  assert.equal((await one(db, `select count(*)::int as n from public.user_achievements where user_id = '${F}'`)).n, 1, 'not quarantined again');
  assert.equal((await achievementRows(db, 'private.achievements_quarantine')).length, q1, 'quarantine did not grow');
  assert.equal((await one(db, `select count(*)::int as n from private.schema_markers`)).n, 1, 'one marker, however often it runs');
  // an earlier revision of this migration (which created the quarantine table) already did its cleanup
  const old = await legacy();
  await seedHistory(old.db);
  await old.db.exec(`create schema private; create table private.achievements_quarantine (user_id uuid not null, achievement_id text not null, unlocked_on date not null, quarantined_at timestamptz not null default now());`);
  await old.db.exec(read(CORE));
  assert.equal((await one(old.db, `select count(*)::int as n from public.user_achievements where user_id = '${F}'`)).n, 5, 'cleanup skipped');
  // a fresh schema.sql database never needs the cleanup and is stamped as done
  const fresh = await makeDb(['supabase/schema.sql']);
  assert.equal((await one(fresh, `select count(*)::int as n from private.schema_markers where name = 'legacy_achievement_cleanup'`)).n, 1);
});

test('AUTH TRIGGER ISOLATION: the core migration installs no trigger on auth.users/sessions/mfa_factors and does not need them', async () => {
  const code = read(CORE).replaceAll('\r\n', '\n').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /on_auth_(user_update|mfa_change|session_delete)|kc_auth_/, 'audit trigger code lives only in the optional file');
  assert.doesNotMatch(code, /(create|drop) trigger[^;]*auth\.(sessions|mfa_factors)/i);
  // core applies even when auth.sessions does not exist at all
  const { db } = await legacy();
  await db.exec('drop table auth.sessions');
  await db.exec(read(CORE));
  assert.deepEqual((await db.query(`select tgname from pg_trigger where tgname like 'kc\\_%'`)).rows, [], 'core installed no audit trigger');
  assert.equal((await one(db, `select to_regprocedure('private.on_auth_session_delete()') is null as none`)).none, true);
  // the audit file refuses to run before the core, and a trigger that cannot be installed only warns
  const early = await legacy();
  await failing(early.db, AUDIT, /apply 2026-09-30_security_hardening\.sql first/);
  await db.exec(`create view auth.sessions as select 1 as id, gen_random_uuid() as user_id`); // triggers cannot be created FOR DELETE on a view
  await db.exec(read(AUDIT)); // must not throw
  const names = (await db.query(`select tgname from pg_trigger where tgname like 'kc\\_%' order by 1`)).rows.map((r) => r.tgname);
  assert.deepEqual(names, ['kc_auth_mfa_change', 'kc_auth_user_update'], 'the two that could be installed are; the failed one only warned');
  await db.exec(read(AUDIT)); // and it is re-runnable
});

// ---------------------------------------------------------------------------------------------------------------------
// Journey date protection (hardened database, straight from schema.sql)
// ---------------------------------------------------------------------------------------------------------------------
test('JOURNEY DATE PROTECTION: a journey cannot be created or edited into "already over", and history freezes once check-ins exist', async () => {
  const db = await makeDb(['supabase/schema.sql']);
  const h = harness(db);
  const [A, B, C] = [uuid(0x21), uuid(0x22), uuid(0x23)];
  for (const u of [A, B, C]) await h.addUser(u);
  const reject = async (fn, re) => { await h.resetLimits(); await assert.rejects(fn(), re); };

  // -- already over: refused on first creation, and as an edit of an existing journey
  await reject(() => h.journey(A, { start: h.day(-40), dur: 30 }), /already be over/);
  await reject(() => h.journey(A, { start: h.day(-3650), dur: 7 }), /already be over/);
  assert.equal((await one(db, `select count(*)::int as n from public.journeys where user_id = $1`, [A])).n, 0, 'nothing was created');
  await h.resetLimits();
  assert.equal((await h.journey(A, { start: h.day(-29), dur: 30 })).ok, true, 'a journey whose last day is TODAY is legitimate');
  await reject(() => h.journey(A, { start: h.day(-100), dur: 30 }), /already be over/);
  await reject(() => h.journey(A, { start: h.day(-30), dur: 30 }), /already be over/); // last day = yesterday
  await h.resetLimits();
  assert.equal((await h.journey(A, { start: h.day(-20), dur: 30 })).ok, true, 'without check-ins the journey is freely editable (onboarding)');
  // it cannot be turned into an instant Journey Complete
  assert.deepEqual((await h.as(A, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r, { ok: true, unlocked: [] });

  // -- with history: B's journey has check-ins on day -2 and day 0
  await h.journey(B, { start: h.day(-3), dur: 30, sw: 72, gw: 62 });
  await h.resetLimits();
  await h.save(B, h.day(-2), h.payload({ weight_kg: 71 }));
  await h.save(B, h.day(0), h.payload({ weight_kg: 70 }));
  await reject(() => h.journey(B, { start: h.day(-10), dur: 30, sw: 72, gw: 62 }), /cannot move earlier, or past the first check-in/);
  await reject(() => h.journey(B, { start: h.day(-100), dur: 365, sw: 72, gw: 62 }), /cannot move earlier/);
  await reject(() => h.journey(B, { start: h.day(0), dur: 30, sw: 72, gw: 62 }), /past the first check-in/);
  await reject(() => h.journey(B, { start: h.day(-3), dur: 30, sw: 75, gw: 62 }), /starting weight cannot change/);
  await reject(() => h.journey(B, { start: h.day(-3), dur: 30, sw: 72, gw: 70 }), /already reached by an existing check-in/); // would hand out Goal Achieved
  await reject(() => h.journey(B, { start: h.day(-3), dur: 30, sw: 72, gw: 71 }), /already reached/);
  const start0 = (await one(db, `select start_date::text s from public.journeys where user_id = $1`, [B])).s;
  assert.equal(start0, h.day(-3), 'the rejected edits changed nothing');
  await h.resetLimits();
  assert.equal((await h.journey(B, { start: h.day(-3), dur: 45, sw: 72, gw: 62, water: 3000 })).ok, true, 'unchanged start/weights, longer duration, new water goal: fine');
  await h.resetLimits();
  assert.equal((await h.journey(B, { start: h.day(-3), dur: 45, sw: 72, gw: 65 })).ok, true, 'a goal not yet reached may change');
  await h.resetLimits();
  assert.equal((await h.journey(B, { start: h.day(-2), dur: 45, sw: 72, gw: 65 })).ok, true, 'moving the start LATER, up to the first check-in, keeps every check-in inside the journey');
  assert.deepEqual((await h.as(B, () => db.query('select public.claim_journey_complete() as r'))).rows[0].r, { ok: true, unlocked: [] });

  // -- starting a NEW journey keeps its behaviour, but not into the past-and-over either
  await h.journey(C, { start: h.day(0), dur: 30, sw: 80, gw: 70 });
  await db.query(`update public.journeys set start_date = $2 where user_id = $1`, [C, h.day(-40)]); // owner fixture: finished 11 days ago
  await h.resetLimits();
  const next = (start, dur = 30) => h.as(C, () => db.query(`select public.start_next_journey($1::date, $2, 70, 65, 2500, 'journal') as r`, [start, dur]));
  await assert.rejects(next(h.day(-10), 7), /already be over/);
  assert.equal((await next(h.day(-10), 30)).rows[0].r.ok, true, 'a backdated next journey that is still running is fine');
  assert.equal((await one(db, `select count(*)::int n from public.journeys where user_id = $1 and completed_on is null`, [C])).n, 1);
});
