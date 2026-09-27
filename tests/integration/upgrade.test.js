// Upgrade path: a database provisioned BEFORE the security hardening (tests/fixtures/schema.pre-hardening.sql is the exact
// previous schema.sql) is brought forward with the migrations, in order, and must end up identical to a fresh schema.sql.
// It also keeps the earlier migration re-run tests, which need the pre-hardening shape.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, harness, read, uuid } from './helpers.js';

const MIGRATIONS = {
  exercise: 'supabase/migrations/2026-09-27_exercise_unit.sql',
  goal: 'supabase/migrations/2026-09-28_goal_achievement.sql',
  journey: 'supabase/migrations/2026-09-29_journey_complete.sql',
  hardening: 'supabase/migrations/2026-09-30_security_hardening.sql',
  audit: 'supabase/migrations/2026-09-30b_auth_audit_triggers.sql',
  movement: 'supabase/migrations/2026-10-01_movement_journal.sql',
};
const [A, B, CAROL, FORGER, LEGIT] = [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)];
let old, h; // the pre-hardening database

before(async () => {
  old = await makeDb(['tests/fixtures/schema.pre-hardening.sql']);
  h = harness(old);
  for (const [id, n] of [[A, 'A'], [B, 'B'], [CAROL, 'Carol'], [FORGER, 'Forger'], [LEGIT, 'Legit']]) await h.addUser(id, n);
});

const payload = (over = {}) => ({ mood: 'good', weight_kg: 70.5, water_ml: 2000, exercise_type: 'Gym', exercise_minutes: 30, notes: 'n', meals: [], ...over });

// ---- ported from schema.test.js: these prove the OLD migrations were re-runnable on the OLD shape ----
test('migration 2026-09-27_exercise_unit.sql is re-runnable and keeps save_checkin working (pre-hardening shape)', async () => {
  await old.exec(read(MIGRATIONS.exercise));
  await old.exec(read(MIGRATIONS.exercise));
  await h.as(A, () => old.query(`select public.save_checkin('2026-09-13', $1::jsonb)`, [JSON.stringify(payload({ exercise_minutes: 60, exercise_unit: 'hours' }))]));
  assert.equal((await h.as(A, () => old.query(`select exercise_unit from public.checkins where checkin_date='2026-09-13'`))).rows[0].exercise_unit, 'hours');
});

test('migration 2026-09-28_goal_achievement.sql is re-runnable on top of the schema (pre-hardening shape)', async () => {
  await old.exec(read(MIGRATIONS.goal));
  await old.exec(read(MIGRATIONS.goal));
  await h.as(CAROL, () => old.query(`select public.create_journey('2026-10-02'::date, 30, 60, 70, 2500)`));
  await h.as(CAROL, () => old.query(`update public.journeys set post_goal_mode='maintain', next_goal_weight=null where user_id=$1 and completed_on is null`, [CAROL]));
  await assert.rejects(h.as(CAROL, () => old.query(`update public.journeys set post_goal_mode='new_goal' where user_id=$1 and completed_on is null`, [CAROL])), /violates|check/i);
});

test('migration 2026-09-29_journey_complete.sql is re-runnable on the pre-migration shape', async () => {
  await old.exec(read(MIGRATIONS.journey));
  await old.exec(read(MIGRATIONS.journey));
  assert.equal((await h.as(CAROL, () => old.query(`select count(*)::int as n from public.journeys`))).rows[0].n, 1);
});

// ---- the hardening upgrade ----
test('BEFORE the hardening the browser could forge achievements and rewrite journeys (the vulnerability being fixed)', async () => {
  await h.as(FORGER, () => old.query(`insert into public.user_achievements values ($1, 'goal', current_date), ($1, 'd14', current_date), ($1, 'consistent', current_date)`, [FORGER]));
  await h.as(FORGER, () => old.query(`select public.create_journey(current_date, 30, 70, 60, 2500)`));
  await h.as(FORGER, () => old.query(`update public.journeys set duration_days = 7, start_date = current_date - 30 where user_id = $1`, [FORGER]));
  // a legitimate user: one real check-in today, and the 'first' achievement it earned (plus one forged extra)
  await h.as(LEGIT, () => old.query(`select public.create_journey(current_date, 30, 70, 60, 2500)`));
  await h.as(LEGIT, () => old.query(`select public.save_checkin(current_date, $1::jsonb)`, [JSON.stringify(payload())]));
  await h.as(LEGIT, () => old.query(`insert into public.user_achievements values ($1, 'first', current_date), ($1, 'd14', current_date)`, [LEGIT]));
  assert.equal((await old.query(`select count(*)::int n from public.user_achievements`)).rows[0].n, 5);
});

test('the older migrations now refuse to run once the hardening is applied (they would re-open direct writes)', async () => {
  const after = await makeDb(['supabase/schema.sql']);
  for (const m of [MIGRATIONS.exercise, MIGRATIONS.goal, MIGRATIONS.journey]) await assert.rejects(after.exec(read(m)), /security hardening .* already applied/, m);
  const grants = await after.query(`select has_table_privilege('authenticated', 'public.journeys', 'update') as u, has_table_privilege('authenticated', 'public.user_achievements', 'insert') as i`);
  assert.deepEqual(grants.rows[0], { u: false, i: false }, 'still locked down after the refused re-run');
});

test('hardening migration: quarantines forged achievements ONCE, keeps derivable ones, locks direct writes', async () => {
  await old.exec(read(MIGRATIONS.hardening));
  await old.exec(read(MIGRATIONS.audit)); // the optional auth audit triggers
  const left = (await old.query(`select user_id::text u, achievement_id a from public.user_achievements order by 1, 2`)).rows;
  assert.deepEqual(left, [{ u: LEGIT, a: 'first' }], 'only the derivable achievement survives');
  const q = (await old.query(`select user_id::text u, achievement_id a from private.achievements_quarantine order by 1, 2`)).rows;
  assert.deepEqual(q, [
    { u: FORGER, a: 'consistent' }, { u: FORGER, a: 'd14' }, { u: FORGER, a: 'goal' }, { u: LEGIT, a: 'd14' },
  ].sort((x, y) => (x.u + x.a < y.u + y.a ? -1 : 1)), 'forged rows kept for review, not deleted silently');
  // a second run does NOT repeat the cleanup: a row added afterwards (owner-level) is not quarantined
  await old.exec(`insert into public.user_achievements values ('${FORGER}', 'goal', current_date)`);
  await old.exec(read(MIGRATIONS.hardening));
  assert.equal((await old.query(`select count(*)::int n from public.user_achievements where user_id = $1`, [FORGER])).rows[0].n, 1, 'the cleanup did not run again');
  assert.equal((await old.query(`select count(*)::int n from private.achievements_quarantine`)).rows[0].n, 4, 'quarantine unchanged by the re-run');
  await old.exec(`delete from public.user_achievements where user_id = '${FORGER}'`);
  // the browser can no longer write
  await assert.rejects(h.as(FORGER, () => old.query(`insert into public.user_achievements values ($1, 'goal', current_date)`, [FORGER])), /permission denied/);
  await assert.rejects(h.as(FORGER, () => old.query(`update public.journeys set duration_days = 7 where user_id = $1`, [FORGER])), /permission denied/);
  // ...but everything legitimate still works
  assert.equal((await h.as(LEGIT, () => old.query(`select public.save_checkin(current_date, $1::jsonb) as r`, [JSON.stringify(payload({ water_ml: 2600 }))]))).rows[0].r.ok, true);
  assert.equal((await h.as(LEGIT, () => old.query('select water_ml from public.checkins'))).rows[0].water_ml, 2600);
});

// ---- the movement journal (separate from the hardening): applied on top of the hardened database ----
test('movement migration: refuses to run before the hardening, then upgrades in place, keeps old check-ins and is re-runnable', async () => {
  const preHardening = await makeDb(['tests/fixtures/schema.pre-hardening.sql']);
  await assert.rejects(preHardening.exec(read(MIGRATIONS.movement)), /apply the security hardening/);
  await old.exec(read(MIGRATIONS.movement));
  await old.exec(read(MIGRATIONS.movement));
  // the legitimate user's pre-existing "Gym, 30 min" check-in is untouched, and reads as "details not recorded"
  const r = (await h.as(LEGIT, () => old.query('select exercise_type, exercise_minutes, exercise_muscles, exercise_distance_mi, exercise_steps, exercise_description from public.checkins'))).rows;
  assert.deepEqual(r, [{ exercise_type: 'Gym', exercise_minutes: 30, exercise_muscles: [], exercise_distance_mi: null, exercise_steps: null, exercise_description: '' }]);
  // and the new details save through the same RPC
  const ok = await h.as(LEGIT, () => old.query(`select public.save_checkin(current_date, $1::jsonb) as r`, [JSON.stringify(payload({ exercise_minutes: 70, exercise_muscles: ['Chest', 'Biceps'] }))]));
  assert.equal(ok.rows[0].r.ok, true);
  assert.deepEqual((await h.as(LEGIT, () => old.query('select exercise_muscles from public.checkins'))).rows, [{ exercise_muscles: ['Chest', 'Biceps'] }]);
});

// ---- schema.sql and the migration must describe the same database ----
const catalog = async (db) => {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    functions: await q(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as sig,
        regexp_replace(pg_get_functiondef(p.oid), '\\s+', ' ', 'g') as def, p.prosecdef, coalesce(p.proconfig, '{}') cfg,
        has_function_privilege('anon', p.oid, 'execute') anon_x, has_function_privilege('authenticated', p.oid, 'execute') auth_x,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) public_x
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') and p.prokind = 'f' order by 1`),
    policies: await q(`select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2`),
    tables: await q(`select n.nspname, c.relname, c.relrowsecurity rls,
        has_table_privilege('anon', c.oid, 'select,insert,update,delete') anon_any,
        has_table_privilege('authenticated', c.oid, 'select') s, has_table_privilege('authenticated', c.oid, 'insert') i,
        has_table_privilege('authenticated', c.oid, 'update') u, has_table_privilege('authenticated', c.oid, 'delete') d
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relkind = 'r' order by 1,2`),
    columnPrivs: await q(`select table_name, column_name, privilege_type from information_schema.column_privileges
      where grantee = 'authenticated' and table_schema = 'public' and privilege_type <> 'SELECT' order by 1,2,3`),
    columns: await q(`select table_schema, table_name, column_name, data_type from information_schema.columns where table_schema in ('public','private') order by 1,2,column_name`),
    indexes: await q(`select schemaname, tablename, indexname from pg_indexes where schemaname in ('public','private') order by 1,2,3`),
    triggers: await q(`select tgrelid::regclass::text tbl, tgname from pg_trigger where not tgisinternal order by 1,2`),
  };
};

test('an upgraded database is indistinguishable from a fresh schema.sql (functions, grants, policies, tables, triggers)', async () => {
  const fresh = await makeDb(['supabase/schema.sql']);
  const [a, b] = [await catalog(fresh), await catalog(old)];
  for (const k of Object.keys(a)) assert.deepEqual(b[k], a[k], `catalog section "${k}" differs between schema.sql and the upgrade path`);
});

test('schema.sql and the migrations carry byte-identical core and audit-trigger sections', () => {
  for (const [tag, file, min] of [['SECURITY HARDENING', MIGRATIONS.hardening, 5000], ['AUTH AUDIT TRIGGERS', MIGRATIONS.audit, 1500], ['MOVEMENT JOURNAL', MIGRATIONS.movement, 3000]]) {
    const grab = (sql) => sql.slice(sql.indexOf(`-- >>> ${tag}`), sql.indexOf(`-- <<< ${tag}`)).replaceAll('\r\n', '\n');
    const [s, m] = [grab(read('supabase/schema.sql')), grab(read(file))];
    assert.ok(s.length > min, `${tag} section found`);
    assert.equal(m, s, tag);
  }
});

test('no service-role key, secret or password appears in any SQL file', () => {
  for (const f of ['supabase/schema.sql', ...Object.values(MIGRATIONS)]) {
    assert.doesNotMatch(read(f), /service_role|eyJ[A-Za-z0-9_-]{20,}|sb_secret_|password\s*=\s*'[^']/i, f);
  }
});
