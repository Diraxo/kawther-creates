// LIVE Supabase integration test. Uses the app's real SupabaseRepository against your project with
// two brand-new accounts (A, B) and checks persistence, atomicity and cross-user isolation.
//   node tests/live/repo.live.mjs        (needs .env with the project URL + anon key; "Confirm email" OFF)
// Test accounts are left in place (deleting auth users needs the service-role key, which we never use).
import { URL_, KEY, testEmail } from './env.mjs';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../../src/data/supabaseRepository.js';
import { AuthError } from '../../src/data/errors.js';
import { addDays, todayStr } from '../../src/domain/dates.js';

let passed = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { passed++; console.log('  ✓', n); } else { failures.push(n); console.log('  ✗', n, d); } };
const rejects = async (p) => { try { await p; return false; } catch { return true; } };

const today = todayStr();
const mk = () => new SupabaseRepository({ url: URL_, anonKey: KEY });
const meals = (n) => ({ breakfast: [{ name: 'Eggs', notes: '', time: '8:30 AM' }], lunch: [], dinner: [{ name: n, notes: 'n', time: '7:00 PM' }], snacks: [] });
const ci = (o = {}) => ({ mood: 'great', weight: 71.5, water: 2600, meals: meals('Fish'), exercise: { type: 'Running', duration: 30 }, notes: 'live test', ...o });

console.log('\nAccount A: signup -> profile -> onboarding -> check-in');
const a = mk();
const emailA = testEmail('a');
const pass = 'Test-pass-12345';
let userA;
try {
  userA = await a.signUp({ name: 'Live Tester A', email: emailA, password: pass });
} catch (e) {
  console.log('signUp failed:', e.code, e.message);
  process.exit(1);
}
check('signUp returns a session-backed user (Confirm email must be OFF)', !!userA);
check('profile row created by trigger with the right name/email', userA.name === 'Live Tester A' && userA.email === emailA && userA.onboarded === false);
check('duplicate signup is rejected as EXISTS', await (async () => { try { await mk().signUp({ name: 'x', email: emailA, password: pass }); return false; } catch (e) { return e instanceof AuthError && e.code === 'EXISTS'; } })());
check('wrong password -> INVALID_CREDENTIALS', await (async () => { try { await mk().signIn(emailA, 'nope-nope-1'); return false; } catch (e) { return e.code === 'INVALID_CREDENTIALS'; } })());

await a.createJourney({ start: addDays(today, -1), duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 });
await a.updateWaterGoal(3000);
await a.saveCheckin(addDays(today, -2), ci({ water: 3100, weight: 72 }));
const s1 = await a.saveCheckin(addDays(today, -1), ci({ water: 3100, weight: 72 }));
const s2 = await a.saveCheckin(today, ci());
const s3 = await a.saveCheckin(today, ci({ water: 3200, meals: meals('Chicken') })); // update same day: no duplicate
// Achievements are granted by the DATABASE from the saved rows (the browser can no longer write them): First Step with the
// first check-in of "today", the 3-day streak once three consecutive days exist, and never twice.
check('server grants First Step, then the 3-Day Streak, exactly once each', s1.unlocked.map((u) => u.id).join() === 'first' && s2.unlocked.map((u) => u.id).join() === 'd3' && s3.unlocked.length === 0, JSON.stringify([s1, s2, s3]));

let s = await a.getSession();
check('reload: onboarded + journey persisted', s.onboarded && s.journey.duration === 60 && s.journey.waterGoal === 3000);
check('reload: 3 check-ins (update did not duplicate)', Object.keys(s.checkins).length === 3);
check('reload: today updated to 3.2 L and meal replaced', s.checkins[today].water === 3200 && s.checkins[today].meals.dinner.length === 1 && s.checkins[today].meals.dinner[0].name === 'Chicken');
check('reload: weight / mood / exercise / notes round-trip', s.checkins[today].weight === 71.5 && s.checkins[today].mood === 'great' && s.checkins[today].exercise.type === 'Running' && s.checkins[today].notes === 'live test');
check('reload: achievements persisted once each, dated by the server', s.unlocked.length === 2 && s.unlockedDates.first === addDays(today, -1) && s.unlockedDates.d3 === today);

console.log('\nFresh login (new client = new browser) sees the same data');
await a.signOut();
const a2 = mk();
s = await a2.signIn(emailA, pass);
check('login again: all data remains', Object.keys(s.checkins).length === 3 && s.unlocked.length === 2 && s.journey.waterGoal === 3000);

console.log('\nAtomicity: a rejected save changes nothing');
const before = (await a2.getSession()).checkins[today];
const bad = ci({ water: 111, meals: { ...meals('X'), lunch: [{ name: '', notes: '', time: '1:00 PM' }] } }); // empty meal name violates a CHECK
check('save with an invalid meal is rejected (throws)', await rejects(a2.saveCheckin(today, bad)));
const after = (await a2.getSession()).checkins[today];
check('...and today is unchanged (check-in AND meals rolled back)', JSON.stringify(before) === JSON.stringify(after));

console.log("\nAccount B: isolation (IDOR / RLS) using raw queries from B's authenticated client");
const b = mk();
const userB = await b.signUp({ name: 'Live Tester B', email: testEmail('b'), password: pass });
check('B starts with nothing (no shared data leaked in)', userB.onboarded === false && Object.keys(userB.checkins).length === 0 && userB.unlocked.length === 0);
const { data: { user: ua } } = await a2.sb.auth.getUser();
const { data: { user: ub } } = await b.sb.auth.getUser();
const { data: aRows } = await a2.sb.from('checkins').select('id').eq('user_id', ua.id);
const idA = aRows[0].id;
const count = async (q) => { const { data } = await q; return data ? (Array.isArray(data) ? data.length : 1) : 0; };
check("B cannot SELECT A's check-ins (by user_id)", (await count(b.sb.from('checkins').select('*').eq('user_id', ua.id))) === 0);
check("B cannot SELECT A's check-in by primary key", (await count(b.sb.from('checkins').select('*').eq('id', idA))) === 0);
check("B cannot SELECT A's meals / journey / profile / achievements",
  (await count(b.sb.from('checkin_meals').select('*').eq('user_id', ua.id))) === 0 &&
  (await count(b.sb.from('journeys').select('*').eq('user_id', ua.id))) === 0 &&
  (await count(b.sb.from('profiles').select('*').eq('id', ua.id))) === 0 &&
  (await count(b.sb.from('user_achievements').select('*').eq('user_id', ua.id))) === 0);
const upd = await b.sb.from('checkins').update({ water_ml: 0 }).eq('id', idA).select();
check("B's UPDATE of A's check-in affects 0 rows", !upd.error && upd.data.length === 0);
const del = await b.sb.from('checkin_meals').delete().eq('checkin_id', idA).select();
check("B's DELETE of A's meals affects 0 rows", !del.error && del.data.length === 0);
check('B cannot INSERT a check-in owned by A', (await b.sb.from('checkins').insert({ user_id: ua.id, checkin_date: '2020-01-01' })).error !== null);
check("B cannot INSERT a meal onto A's check-in (composite FK)", (await b.sb.from('checkin_meals').insert({ checkin_id: idA, user_id: ub.id, category: 'lunch', name: 'x', eaten_at: '12:00' })).error !== null);
check('B cannot grant A an achievement', (await b.sb.from('user_achievements').insert({ user_id: ua.id, achievement_id: 'd14', unlocked_on: today })).error !== null);
check('B cannot change own profile email (column privilege)', (await b.sb.from('profiles').update({ email: 'someone.else@example.com' }).eq('id', ub.id)).error !== null);
const anon = createClient(URL_, KEY);
check('unauthenticated (anon key only) reads nothing', (await count(anon.from('checkins').select('*'))) === 0 && (await count(anon.from('profiles').select('*'))) === 0);
check('unauthenticated cannot call save_checkin', (await anon.rpc('save_checkin', { p_date: today, p_checkin: {} })).error !== null);
const still = await a2.getSession();
check("A's data is completely intact after all of B's attacks", still.checkins[today].water === 3200 && Object.keys(still.checkins).length === 3 && still.unlocked.length === 2);
console.log('\nMovement duration unit + one-row-per-day');
const notVerified = [];
const { error: unitErr } = await a2.sb.from('checkins').select('exercise_unit').limit(1);
await a2.saveCheckin(today, ci({ exercise: { type: 'Gym', duration: 90, unit: 'hours' } }));
s = await a2.getSession();
check('re-saving today updates the same row (still 2 check-ins, none duplicated)', Object.keys(s.checkins).length === 2);
check('duration is never lost (90 minutes stored)', s.checkins[today].exercise.duration === 90);
if (unitErr) notVerified.push('exercise_unit round trip (hours) - column missing: run supabase/migrations/2026-09-27_exercise_unit.sql');
else check('unit "hours" round-trips through Supabase', s.checkins[today].exercise.unit === 'hours');

console.log('\nChange password (real Supabase Auth)');
const NEW_PASS = 'Changed-pass-67890';
const rejectsWith = async (p, code) => { try { await p; return false; } catch (e) { return e instanceof AuthError && e.code === code; } };
check('wrong current password is rejected (INVALID_CREDENTIALS)', await rejectsWith(a2.changePassword('Not-the-password-1', NEW_PASS), 'INVALID_CREDENTIALS'));
check('rejected change left the old password working', await (async () => { const t = mk(); try { await t.signIn(emailA, pass); await t.sb.auth.signOut({ scope: 'local' }); return true; } catch { return false; } })());
await a2.changePassword(pass, NEW_PASS);
check('after a valid change the NEW password signs in', await (async () => { const t = mk(); try { await t.signIn(emailA, NEW_PASS); await t.sb.auth.signOut({ scope: 'local' }); return true; } catch { return false; } })());
check('...and the OLD password no longer works', await rejectsWith(mk().signIn(emailA, pass), 'INVALID_CREDENTIALS'));
check('the active session survives the change (data still readable)', Object.keys((await a2.getSession()).checkins).length === 2);
check('changing to the same password is reported (SAME_PASSWORD)', await rejectsWith(a2.changePassword(NEW_PASS, NEW_PASS), 'SAME_PASSWORD'));
await a2.signOut();
await b.signOut();

if (notVerified.length) console.log('\nNOT VERIFIED:\n - ' + notVerified.join('\n - '));
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
