// LIVE security test against the real Supabase project. It attacks the way a malicious user would from DevTools:
// raw supabase-js calls with their OWN valid session. Everything below must be refused by the database itself.
//   node tests/live/security.live.mjs      (needs .env; "Confirm email" OFF; the 2026-09-30 hardening migration applied)
// Uses brand-new throw-away accounts. Deleting auth users needs the service-role key, which this repo never holds, so the
// accounts remain (empty of value, clearly named kc.test.*). No key beyond the public anon key is used.
import { createHmac } from 'node:crypto';
import { URL_, KEY, testEmail } from './env.mjs';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../../src/data/supabaseRepository.js';
import { AuthError } from '../../src/data/errors.js';
import { addDays, todayStr } from '../../src/domain/dates.js';

let passed = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { passed++; console.log('  ✓', n); } else { failures.push(n); console.log('  ✗', n, d); } };
const section = (t) => console.log('\n' + t);
const today = todayStr();
const PASS = 'Test-pass-12345';
const meals = { breakfast: [{ name: 'Eggs', notes: '', time: '8:30 AM' }], lunch: [], dinner: [], snacks: [] };
const ci = (o = {}) => ({ mood: 'good', weight: 71, water: 2600, meals, exercise: { type: 'Gym', duration: 30, unit: 'minutes' }, notes: 'live security test', ...o });
const mk = () => new SupabaseRepository({ url: URL_, anonKey: KEY });
/** true when the operation did NOT change anything: refused with an error, or matched no rows. */
const refused = (r) => !!r.error || (Array.isArray(r.data) && r.data.length === 0) || r.data === null || r.count === 0;

// --- minimal RFC 6238 TOTP so the MFA path can be exercised for real -------------------------------------------------
function totp(secretB32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

section('Accounts');
const a = mk(); const b = mk();
const emailA = testEmail('sec-a'); const emailB = testEmail('sec-b');
await a.signUp({ name: 'Sec A', email: emailA, password: PASS });
const userB = await b.signUp({ name: 'Sec B', email: emailB, password: PASS });
const uidA = (await a.sb.auth.getUser()).data.user.id;
const uidB = (await b.sb.auth.getUser()).data.user.id;
await a.createJourney({ start: addDays(today, -2), duration: 30, startWeight: 72, goalWeight: 62, waterGoal: 2500 });
await b.createJourney({ start: addDays(today, -2), duration: 30, startWeight: 80, goalWeight: 70, waterGoal: 2500 });
const first = await b.saveCheckin(today, ci({ weight: 79 }));
check('legit: B saves a check-in and the SERVER grants First Step', first.unlocked.length === 1 && first.unlocked[0].id === 'first', JSON.stringify(first));
check('legit: re-saving grants nothing twice', (await b.saveCheckin(today, ci({ weight: 79 }))).unlocked.length === 0);
check('legit: the achievement is readable and dated by the server', (await b.sb.from('user_achievements').select('*')).data.some((r) => r.achievement_id === 'first' && r.unlocked_on === today));

section('Achievement forgery: A cannot write achievements (own or B\'s)');
for (const id of ['goal', 'd14', 'consistent', 'journey', 'd7', 'hydrated']) {
  const r = await a.sb.from('user_achievements').insert({ user_id: uidA, achievement_id: id, unlocked_on: today });
  check(`INSERT own '${id}' refused`, !!r.error, JSON.stringify(r.data));
}
check('UPSERT own achievement refused', !!(await a.sb.from('user_achievements').upsert({ user_id: uidA, achievement_id: 'goal', unlocked_on: today }, { onConflict: 'user_id,achievement_id' })).error);
check("INSERT achievement for B refused", !!(await a.sb.from('user_achievements').insert({ user_id: uidB, achievement_id: 'goal', unlocked_on: today })).error);
check("UPDATE B's achievement (id / date) changes nothing", refused(await a.sb.from('user_achievements').update({ achievement_id: 'goal', unlocked_on: '2000-01-01' }).eq('user_id', uidB).select()));
check('UPDATE own achievement changes nothing', refused(await b.sb.from('user_achievements').update({ unlocked_on: '2000-01-01' }).eq('user_id', uidB).select()));
check('DELETE achievement changes nothing', refused(await b.sb.from('user_achievements').delete().eq('user_id', uidB).select()));
check('A still has NO achievements', (await a.sb.from('user_achievements').select('*')).data.length === 0);
const bAch = (await b.sb.from('user_achievements').select('*')).data;
check("B's achievement is unchanged (still First Step, real date)", bAch.length === 1 && bAch[0].achievement_id === 'first' && bAch[0].unlocked_on === today);

section('Direct table writes are refused (journeys, check-ins, meals, profiles, events)');
check('journeys: UPDATE own (duration/goal/completed) refused', refused(await a.sb.from('journeys').update({ duration_days: 7, goal_weight: 72, completed_on: today }).eq('user_id', uidA).select()));
check('journeys: UPDATE post_goal_mode refused', refused(await a.sb.from('journeys').update({ post_goal_mode: 'maintain' }).eq('user_id', uidA).select()));
check('journeys: INSERT a second journey refused', !!(await a.sb.from('journeys').insert({ user_id: uidA, start_date: today, duration_days: 30, start_weight: 70, goal_weight: 60 })).error);
check("journeys: UPDATE B's journey changes nothing", refused(await a.sb.from('journeys').update({ water_goal_ml: 500 }).eq('user_id', uidB).select()));
check('checkins: INSERT own (bypassing validation) refused', !!(await a.sb.from('checkins').insert({ user_id: uidA, checkin_date: addDays(today, -1), weight_kg: 100, water_ml: 100 })).error);
check("checkins: INSERT for B refused", !!(await a.sb.from('checkins').insert({ user_id: uidB, checkin_date: addDays(today, -1) })).error);
check('checkins: UPDATE own refused', refused(await b.sb.from('checkins').update({ weight_kg: 50 }).eq('user_id', uidB).select()));
check("checkins: UPDATE/DELETE B's changes nothing", refused(await a.sb.from('checkins').update({ weight_kg: 50 }).eq('user_id', uidB).select()) && refused(await a.sb.from('checkins').delete().eq('user_id', uidB).select()));
check('checkin_meals: INSERT / DELETE refused', !!(await a.sb.from('checkin_meals').insert({ checkin_id: uidA, user_id: uidA, category: 'lunch', name: 'x', eaten_at: '12:00' })).error && refused(await b.sb.from('checkin_meals').delete().eq('user_id', uidB).select()));
check('profiles: onboarded / email are not writable', !!(await a.sb.from('profiles').update({ onboarded: false }).eq('id', uidA)).error && !!(await a.sb.from('profiles').update({ email: 'x@y.z' }).eq('id', uidA)).error);
check('security_events: INSERT / UPDATE / DELETE refused', !!(await a.sb.from('security_events').insert({ user_id: uidA, event_type: 'login' })).error && refused(await a.sb.from('security_events').update({ event_type: 'login' }).eq('user_id', uidA).select()) && refused(await a.sb.from('security_events').delete().eq('user_id', uidA).select()));
const bAfter = (await b.sb.from('checkins').select('*')).data;
check("B's check-in is untouched by every attack above", bAfter.length === 1 && Number(bAfter[0].weight_kg) === 79);

section('User isolation (reads)');
for (const t of ['profiles', 'journeys', 'checkins', 'checkin_meals', 'user_achievements', 'security_events']) {
  const rows = (await a.sb.from(t).select('*')).data;
  check(`A sees only their own ${t}`, rows.every((r) => (r.user_id ?? r.id) === uidA), JSON.stringify(rows).slice(0, 120));
}
check("A cannot read B's rows even by id", (await a.sb.from('checkins').select('*').eq('user_id', uidB)).data.length === 0);

section('Server-side validation (raw RPC calls with hand-crafted payloads)');
const rpc = (c, name, args) => c.sb.rpc(name, args);
const bad = async (label, args) => check(`save_checkin rejects ${label}`, !!(await rpc(a, 'save_checkin', args)).error);
const good = { mood: 'good', weight_kg: 70, water_ml: 2000, exercise_type: null, exercise_minutes: null, notes: '', meals: [] };
await bad('weight 29.9', { p_date: today, p_checkin: { ...good, weight_kg: 29.9 } });
await bad('weight 300.1', { p_date: today, p_checkin: { ...good, weight_kg: 300.1 } });
await bad('water 20001', { p_date: today, p_checkin: { ...good, water_ml: 20001 } });
await bad('notes 4001 chars', { p_date: today, p_checkin: { ...good, notes: 'x'.repeat(4001) } });
await bad('31 meals', { p_date: today, p_checkin: { ...good, meals: Array.from({ length: 31 }, (_, i) => ({ category: 'snacks', name: 'm' + i, eaten_at: '10:00', position: i })) } });
await bad('a tomorrow+1 date', { p_date: addDays(today, 3), p_checkin: good });
await bad('a date 500 days back', { p_date: addDays(today, -500), p_checkin: good });
await bad('exercise minutes 1441', { p_date: today, p_checkin: { ...good, exercise_type: 'Gym', exercise_minutes: 1441 } });
check('save_checkin AT the limits succeeds (30 meals, 4000-char notes, 300 kg, 20000 ml)', (await rpc(a, 'save_checkin', { p_date: today, p_checkin: { ...good, weight_kg: 300, water_ml: 20000, notes: 'x'.repeat(4000), meals: Array.from({ length: 30 }, (_, i) => ({ category: 'snacks', name: 'm' + i, eaten_at: '10:00', position: i })) } })).data?.ok === true);
check('smuggled user_id in the payload is ignored (row still A\'s)', (await rpc(a, 'save_checkin', { p_date: addDays(today, -1), p_checkin: { ...good, user_id: uidB } })).data?.ok === true && (await a.sb.from('checkins').select('user_id')).data.every((r) => r.user_id === uidA));
check('create_journey rejects duration 6 / 366, water 499, weight 29.9', (await Promise.all([[6, 70, 2500], [366, 70, 2500], [30, 70, 499], [30, 29.9, 2500]].map(([d, w, ml]) => rpc(a, 'create_journey', { p_start: today, p_duration: d, p_start_weight: w, p_goal_weight: 65, p_water_goal: ml })))).every((r) => !!r.error));
check('create_journey rejects a start date 11 years back', !!(await rpc(a, 'create_journey', { p_start: addDays(today, -4100), p_duration: 30, p_start_weight: 70, p_goal_weight: 65, p_water_goal: 2500 })).error);
check('set_post_goal cannot be claimed without a server-derived goal', !!(await rpc(a, 'set_post_goal', { p_mode: 'maintain', p_next: null })).error);
check('update_water_goal rejects 499 / 6001', !!(await rpc(a, 'update_water_goal', { p_ml: 499 })).error && !!(await rpc(a, 'update_water_goal', { p_ml: 6001 })).error);
check('still exactly ONE journey for A after create_journey calls', (await a.sb.from('journeys').select('id').is('completed_on', null)).data.length === 1);
check('a fake goal cannot be set through the RPC surface either: A has no goal achievement', !(await a.sb.from('user_achievements').select('*')).data.some((r) => r.achievement_id === 'goal'));

section('Privileged helpers are not reachable from the browser');
const anon = createClient(URL_, KEY, { auth: { persistSession: false } });
for (const fn of ['grant_achievements', 'earned_achievements', 'rate_check', 'log_security_event', 'aal_ok']) {
  const r = await a.sb.rpc(fn, {});
  check(`rpc('${fn}') does not exist for the API (private schema)`, !!r.error && /not find|not exist|schema cache|404|permission/i.test(JSON.stringify(r.error)), JSON.stringify(r.error));
}
for (const fn of ['save_checkin', 'create_journey', 'update_water_goal', 'claim_journey_complete']) {
  const r = await anon.rpc(fn, { p_date: today, p_checkin: {}, p_start: today, p_duration: 30, p_start_weight: 70, p_goal_weight: 65, p_water_goal: 2500, p_ml: 2500 });
  check(`anon cannot call ${fn}`, !!r.error, JSON.stringify(r.data));
}
for (const t of ['profiles', 'journeys', 'checkins', 'checkin_meals', 'user_achievements', 'security_events']) {
  const r = await anon.from(t).select('*');
  check(`anon cannot read ${t}`, !!r.error || r.data.length === 0);
}

section('Rate limiting (per user, server-side)');
const c = mk();
await c.signUp({ name: 'Sec C', email: testEmail('sec-c'), password: PASS });
await c.createJourney({ start: addDays(today, -1), duration: 30, startWeight: 72, goalWeight: 62, waterGoal: 2500 });
let hit = null; let okCount = 0;
for (let i = 0; i < 36 && !hit; i++) {
  try { await c.saveCheckin(today, ci({ water: 1000 + i })); okCount++; } catch (e) { hit = e; }
}
check('normal use is never limited: the first 30 saves in 5 minutes succeed', okCount === 30, `ok=${okCount}`);
check('the 31st save is rejected with a clean RATE_LIMITED error (not a database exception)', hit instanceof AuthError && hit.code === 'RATE_LIMITED' && hit.retryAfter >= 1, String(hit && (hit.code + ' ' + hit.message)));
check('the blocked save changed nothing', (await c.sb.from('checkins').select('water_ml').eq('checkin_date', today)).data[0].water_ml === 1029);
check('another user is unaffected by C\'s limit', (await b.saveCheckin(today, ci({ weight: 79 }))).unlocked !== undefined);
const ev = (await c.sb.from('security_events').select('event_type, details')).data;
check("the rate-limit hit is in C's own security log (deduplicated)", ev.filter((e) => e.event_type === 'rate_limited').length === 1, JSON.stringify(ev));
check('the security log has no tokens/secrets and only the audited columns', Object.keys((await c.sb.from('security_events').select('*').limit(1)).data[0]).sort().join() === 'created_at,details,event_type,id,user_id');

section('Security events from the auth system (signup / login / password change / session revocation)');
const evA = async () => (await a.sb.from('security_events').select('event_type')).data.map((e) => e.event_type);
check('signup was recorded', (await evA()).includes('signup'), (await evA()).join());
const a2 = mk();
await a2.signIn(emailA, PASS);
await sleep(500);
check('login was recorded', (await a2.sb.from('security_events').select('event_type')).data.some((e) => e.event_type === 'login'));
await a2.changePassword(PASS, PASS + '-changed');
await sleep(500);
check('password change was recorded', (await a2.sb.from('security_events').select('event_type')).data.some((e) => e.event_type === 'password_change'));
await a2.changePassword(PASS + '-changed', PASS);

section('Authentication flow still works (signIn / getSession / signOut)');
const a3 = mk();
const s3 = await a3.signIn(emailA, PASS);
check('login returns the user with their data', s3.email === emailA && s3.onboarded === true && Object.keys(s3.checkins).length >= 1);
check('getSession restores it', !!(await a3.getSession()));
check('wrong password -> INVALID_CREDENTIALS', await (async () => { try { await mk().signIn(emailA, 'nope-nope-1'); return false; } catch (e) { return e.code === 'INVALID_CREDENTIALS'; } })());
await a3.signOut();
check('after signOut the session is gone', (await a3.getSession()) === null);
check('after signOut REST reads return nothing', ((await a3.sb.from('checkins').select('*')).data || []).length === 0);
await a.signOut().catch(() => {});

section('Two-factor authentication (real TOTP against Supabase Auth; enforced by the database)');
const m = mk();
const emailM = testEmail('sec-mfa');
await m.signUp({ name: 'Sec MFA', email: emailM, password: PASS });
await m.createJourney({ start: addDays(today, -1), duration: 30, startWeight: 72, goalWeight: 62, waterGoal: 2500 });
let mfaOk = true;
try {
  const en = await m.mfaEnroll();
  check('enrolment returns a QR code and a setup key', /^data:image\/svg\+xml/.test(en.qrCode) && en.secret.length >= 16);
  await m.mfaConfirm(en.factorId, totp(en.secret));
  check('with a correct code, 2FA is on', (await m.mfaStatus()).enabled === true);
  await sleep(300);
  const login = mk();
  let needed = false;
  try { await login.signIn(emailM, PASS); } catch (e) { needed = e.code === 'MFA_REQUIRED'; }
  check('a password-only login is told the code is required (MFA_REQUIRED)', needed);
  check('DATABASE: on that password-only (aal1) session reads return nothing', ((await login.sb.from('journeys').select('*')).data || []).length === 0 && ((await login.sb.from('checkins').select('*')).data || []).length === 0);
  const r1 = await login.sb.rpc('save_checkin', { p_date: today, p_checkin: good });
  check('DATABASE: on that aal1 session save_checkin fails with mfa_required', !!r1.error && /mfa_required/.test(r1.error.message), JSON.stringify(r1.error));
  const r2 = await login.sb.rpc('update_water_goal', { p_ml: 3000 });
  check('DATABASE: on that aal1 session update_water_goal fails too', !!r2.error && /mfa_required/.test(r2.error.message));
  check('a wrong code is MFA_INVALID', await (async () => { try { await login.verifyMfaLogin('000000'); return false; } catch (e) { return e.code === 'MFA_INVALID'; } })());
  await sleep(1000);
  const full = await login.verifyMfaLogin(totp(en.secret));
  check('with the correct code the full session works (aal2) and data loads', full.email === emailM && full.onboarded === true);
  check('aal2: writes succeed again', (await login.saveCheckin(today, ci())).unlocked !== undefined);
  // recovery: a second authenticator can be added from an aal2 session, and removing the first still leaves 2FA on
  const en2 = await login.mfaEnroll();
  await login.mfaConfirm(en2.factorId, totp(en2.secret));
  check('recovery: a second authenticator can be enrolled (from an aal2 session)', (await login.mfaStatus()).factors.length === 2);
  // cleanup: turn 2FA fully off so this throw-away account is left in a normal state
  for (const f of (await login.mfaStatus()).factors) await login.mfaDisable(f.id, totp(f.id === en2.factorId ? en2.secret : en.secret)).catch(() => { mfaOk = false; });
  await sleep(500);
  check('2FA can be turned off again with a valid code', (await login.mfaStatus()).enabled === false && mfaOk);
} catch (e) {
  check('MFA scenario ran to completion (Supabase Auth MFA must be enabled in the dashboard)', false, e.code + ' ' + e.message);
}

section('Summary');
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
