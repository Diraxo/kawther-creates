// APPLICATION COMPATIBILITY: the real SupabaseRepository (with mappers.js and errors.js) is driven against the hardened
// database. Only the network hop is replaced: `sb.rpc(name, args)` runs the same named-argument call PostgREST would, as the
// signed-in `authenticated` role, and returns supabase-js's { data, error } shape. Nothing here touches a hosted project.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, harness, uuid } from './helpers.js';
import { SupabaseRepository } from '../../src/data/supabaseRepository.js';
import { AuthError, classifyError } from '../../src/data/errors.js';

const [ME, MFA] = [uuid(0x31), uuid(0x32)];
let db, h;

/** A repository whose backend is the database: same RPC names, same named arguments, same { data, error } result shape. */
function repoFor(uid, claims = {}) {
  const repo = new SupabaseRepository({ url: 'http://localhost:0', anonKey: 'test' });
  repo.sb = {
    auth: { getSession: async () => ({ data: { session: uid ? { user: { id: uid } } : null }, error: null }) },
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      const call = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const params = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
      try {
        const res = await h.as(uid, () => db.query(call, params), claims);
        return { data: res.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message, code: e.code } }; // what PostgREST returns for a raised exception
      }
    },
  };
  return repo;
}

before(async () => {
  db = await makeDb(['supabase/schema.sql']);
  h = harness(db);
  await h.addUser(ME); await h.addUser(MFA);
  await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${MFA}', 'verified')`);
});

const journey = (o = {}) => ({ start: h.day(0), duration: 30, startWeight: 72, goalWeight: 62, waterGoal: 2500, ...o });
const checkin = (o = {}) => ({ mood: 'good', weight: 71.5, water: 2600, exercise: { type: 'Gym', duration: 30, unit: 'minutes' }, notes: 'ok', meals: { breakfast: [{ name: 'Eggs', time: '8:30 AM' }] }, ...o });

test('every RPC the repository calls exists with exactly the argument names it sends, is SECURITY DEFINER and authenticated-only', async () => {
  const src = readFileSync(new URL('../../src/data/supabaseRepository.js', import.meta.url), 'utf8');
  const called = [...src.matchAll(/#rpc\('([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(called, ['claim_journey_complete', 'create_journey', 'save_checkin', 'set_post_goal', 'start_next_journey', 'update_water_goal']);
  const sig = async (name) => (await db.query(
    `select p.proargnames as names, p.prosecdef as def, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth, format_type(p.prorettype, null) as ret
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name])).rows;
  for (const [name, args] of Object.entries({
    save_checkin: ['p_date', 'p_checkin'],
    create_journey: ['p_start', 'p_duration', 'p_start_weight', 'p_goal_weight', 'p_water_goal'],
    update_water_goal: ['p_ml'],
    start_next_journey: ['p_start', 'p_duration', 'p_start_weight', 'p_goal_weight', 'p_water_goal', 'p_mode'],
    set_post_goal: ['p_mode', 'p_next'],
    claim_journey_complete: [],
  })) {
    const rows = await sig(name);
    assert.equal(rows.length, 1, `${name}: exactly one overload`);
    assert.deepEqual(rows[0].names || [], args, `${name}: argument names`);
    assert.deepEqual([rows[0].def, rows[0].anon, rows[0].auth, rows[0].ret], [true, false, true, 'jsonb'], `${name}: definer, not anon, authenticated, returns jsonb`);
  }
});

test('createJourney / updateWaterGoal / saveCheckin / setPostGoal / claimJourneyComplete / startNextJourney round-trip through the repository', async () => {
  const repo = repoFor(ME);
  assert.equal(await repo.createJourney(journey({ goalWeight: 65, startWeight: 72 })), undefined);
  assert.equal(await repo.updateWaterGoal(3000), undefined);
  const r1 = await repo.saveCheckin(h.day(0), checkin({ weight: 71 }));
  assert.deepEqual(r1, { unlocked: [{ id: 'first', date: h.day(0) }] }, 'return shape: { unlocked: [{ id, date }] } from {id, on}');
  assert.deepEqual(await repo.claimJourneyComplete(), { unlocked: [] });
  await assert.rejects(repo.setPostGoal('maintain'), (e) => e instanceof AuthError && e.code === 'UNKNOWN' && /goal not reached/.test(e.message), 'a goal the server has not derived cannot be claimed');
  const r2 = await repo.saveCheckin(h.day(0), checkin({ weight: 64.5 })); // reaches the goal (loss journey 72 -> 65)
  assert.deepEqual(r2.unlocked.map((u) => u.id), ['goal']);
  assert.equal(await repo.setPostGoal('new_goal', 60), undefined);
  assert.equal(await repo.setPostGoal('journal'), undefined);
  assert.deepEqual((await db.query(`select water_goal_ml as w, post_goal_mode as m, next_goal_weight as n from public.journeys where user_id = $1`, [ME])).rows[0], { w: 3000, m: 'journal', n: null });
  // finish it (owner fixture) and start the next journey the way the app does
  await db.query(`update public.journeys set start_date = $2 where user_id = $1`, [ME, h.day(-29)]); // last day = today
  assert.deepEqual((await repo.claimJourneyComplete()).unlocked.map((u) => u.id), ['journey']);
  await h.resetLimits();
  assert.equal(await repo.startNextJourney(journey({ start: h.day(1), startWeight: 64.5, goalWeight: 60 }), 'new_goal'), undefined);
  assert.equal((await db.query(`select count(*)::int as n from public.journeys where user_id = $1`, [ME])).rows[0].n, 2);
});

test('error handling: rate limits, no session, MFA required, validation and journey-integrity errors are classified for the UI', async () => {
  await h.resetLimits();
  const repo = repoFor(ME);
  // rate_limited comes back as a RESULT (ok:false) and becomes AuthError RATE_LIMITED with retryAfter
  await db.query(`insert into private.rate_events (user_id, bucket) select $1, 'journey_edit' from generate_series(1, 20)`, [ME]);
  await assert.rejects(repo.updateWaterGoal(2500), (e) => e instanceof AuthError && e.code === 'RATE_LIMITED' && e.retryAfter > 0);
  // no session: the repository refuses before calling the database
  await assert.rejects(repoFor(null).saveCheckin(h.day(0), checkin()), (e) => e.code === 'SESSION_EXPIRED');
  // a session the database does not know (auth.uid() null): 'not authenticated' 28000 -> SESSION_EXPIRED
  const raw = repoFor(ME);
  raw.sb.rpc = async (name, args) => {
    await db.exec('set role authenticated'); // signed-in role, but the token carries no subject
    try { return { data: (await db.query('select public.update_water_goal(p_ml => $1) as r', [args.p_ml])).rows[0].r, error: null }; }
    catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
    finally { await db.exec('reset role'); }
  };
  await assert.rejects(raw.updateWaterGoal(2500), (e) => e.code === 'SESSION_EXPIRED');
  // MFA: a password-only (aal1) session of a user with a verified factor
  await assert.rejects(repoFor(MFA, { aal: 'aal1' }).updateWaterGoal(2500), (e) => e.code === 'MFA_REQUIRED');
  await h.resetLimits();
  await repoFor(MFA, { aal: 'aal2' }).createJourney(journey()); // and aal2 is fine
  // validation and the new journey-integrity errors surface as classified errors with their message (the screens show a fallback)
  await assert.rejects(repo.updateWaterGoal(100), (e) => e instanceof AuthError && /invalid water goal/.test(e.message));
  await assert.rejects(repo.createJourney(journey({ start: h.day(-40), duration: 30 })), (e) => e instanceof AuthError && /already be over/.test(e.message));
  await assert.rejects(repo.createJourney(journey({ start: h.day(-3650), duration: 7 })), (e) => e instanceof AuthError && /already be over/.test(e.message));
  assert.equal(classifyError({ message: 'invalid journey: it would already be over', code: '22007' }).code, 'UNKNOWN', 'classified, never thrown raw');
});
