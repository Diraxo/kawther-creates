// PHASE 2, live: a brand-new account through the real UI against the real Supabase project, then
// verifies the rows independently via a SEPARATE supabase-js client (so we test the database, not the UI's memory).
//   node tests/e2e/live.mjs      (needs .env with URL + anon key; Auth "Confirm email" OFF)
import '../live/env.mjs';
import { URL_, KEY, testEmail } from '../live/env.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

let passed = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { passed++; console.log('  ✓', n); } else { failures.push(n); console.log('  ✗', n, d); } };
const section = (t) => console.log('\n' + t);

const PORT = 5176;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, VITE_DATA_BACKEND: 'supabase', VITE_SUPABASE_URL: URL_, VITE_SUPABASE_ANON_KEY: KEY }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 4500));
const BASE = `http://localhost:${PORT}`;

const email = testEmail('ui');
const PASS = 'Test-pass-12345';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_INTERNET|Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });

const txt = (sel) => page.locator(sel).first().evaluate((e) => (e.innerText ?? e.textContent).trim());
const nav = (s) => page.click(`.navbtn[data-s="${s}"]`);
const today = await page.evaluate(() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; });

/** Independent DB read as the test user (fresh client = fresh session). */
async function dbView() {
  const c = createClient(URL_, KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  const q = async (t) => (await c.from(t).select('*')).data;
  const out = { profile: await q('profiles'), journey: await q('journeys'), checkins: await q('checkins'), meals: await q('checkin_meals'), ach: await q('user_achievements') };
  await c.auth.signOut();
  return out;
}

section('Landing -> Signup -> Account -> Profile -> Onboarding');
await page.goto(BASE);
await page.waitForSelector('#s-landing.active');
await page.click('#s-landing [data-target="s-signup"]');
await page.fill('#su-name', 'Live UI Tester');
await page.fill('#su-email', email);
await page.fill('#su-pass', PASS);
await page.fill('#su-pass2', PASS);
await page.click('#s-signup [data-action="signup"]');
try {
  await page.waitForSelector('#s-ob1.active', { timeout: 15000 });
  check('signup created an auth account and entered onboarding', true);
} catch {
  check('signup created an auth account and entered onboarding', false, 'error shown: ' + (await txt('#e-su-email')));
  await browser.close(); server.kill(); process.exit(1);
}
let db = await dbView();
check('DB: profile row exists with name + email, not yet onboarded', db.profile.length === 1 && db.profile[0].full_name === 'Live UI Tester' && db.profile[0].email === email.toLowerCase() && db.profile[0].onboarded === false);
await page.click('#s-ob1 .btn');
await page.fill('#ob-start', '72');
await page.click('#s-ob2 .btn');
await page.fill('#ob-goal', '62');
await page.click('#s-ob3 .btn');
await page.click('#s-ob4 [data-d="60"]');
await page.click('#s-ob4 .btn');
await page.waitForSelector('#s-success.active');
await page.click('#s-success .btn');
await page.waitForSelector('#s-home.active');
check('Home shows DAY 1 OF 60 and the user name', (await txt('#h-daylabel')) === 'DAY 1 OF 60' && (await txt('#h-name')) === 'Live UI Tester');
db = await dbView();
check('DB: journey row (60 days, 72 -> 62 kg) + profile.onboarded = true', db.journey.length === 1 && db.journey[0].duration_days === 60 && Number(db.journey[0].start_weight) === 72 && Number(db.journey[0].goal_weight) === 62 && db.journey[0].start_date === today && db.profile[0].onboarded === true);

section('Check-in: mood, weight, hydration, meals, exercise, save');
await page.click('.navbtn.fab');
await page.waitForSelector('#s-checkin.active');
await page.click('#ci-mood [data-m="great"]');
await page.fill('#ci-weight', '71.5');
await page.click('.editgoal');
await page.fill('#goal-input', '0.5');
await page.click('#ov-goal [data-action="save-goal"]');
db = await dbView();
check('DB: water goal edit persisted immediately (500 ml)', db.journey[0].water_goal_ml === 500);
await page.click('.quickadd button:nth-child(2)'); // +0.5 L
await page.click('[data-action="add-meal"][data-cat="breakfast"]');
await page.fill('#meal-name', 'Oats <b>& berries</b>');
await page.fill('#meal-time', '08:15');
await page.click('#ov-meal [data-action="confirm-meal"]');
await page.click('[data-action="add-meal"][data-cat="dinner"]');
await page.fill('#meal-name', 'Lentils');
await page.fill('#meal-time', '19:00');
await page.click('#ov-meal [data-action="confirm-meal"]');
await page.click('#ci-ex-yes');
await page.selectOption('#ci-ex-type', 'Running');
await page.fill('#ci-ex-dur', '30');
await page.fill('#ci-notes', 'Live test note');
await page.click('#ci-save-btn');
await page.waitForSelector('#ov-celebrate.show');
check('celebration shown only after the save succeeded', (await txt('#cel-streak')) === 'Day 1 of 60 · 1 day streak');
await page.waitForSelector('#ov-milestone.show');
check('1st achievement: First Step', (await txt('#mi-title')) === 'First Step');
await page.click('#ov-milestone .btn');
await page.waitForFunction(() => !document.getElementById('ov-milestone').classList.contains('show'));
check('no fake 2nd achievement: "Consistent" needs 7 check-ins, so only First Step unlocked', true);
await page.click('#ov-celebrate .btn');
await page.waitForSelector('#s-home.active');

section('DB read-back (independent client)');
db = await dbView();
const c = db.checkins[0];
check('DB: exactly one check-in for today with the right values', db.checkins.length === 1 && c.checkin_date === today && c.mood === 'great' && Number(c.weight_kg) === 71.5 && c.water_ml === 500 && c.exercise_type === 'Running' && c.exercise_minutes === 30 && c.notes === 'Live test note');
check('DB: both meals stored with category/name/time (HTML kept as text)', db.meals.length === 2 && db.meals.some((m) => m.category === 'breakfast' && m.name === 'Oats <b>& berries</b>' && m.eaten_at.startsWith('08:15')) && db.meals.some((m) => m.category === 'dinner' && m.name === 'Lentils' && m.eaten_at.startsWith('19:00')));
check('DB: only the achievement really earned (first) is stored', db.ach.map((a) => a.achievement_id).sort().join() === 'first');

section('Home / Progress / Journey / Achievements update');
check('Home: check-in complete, weight, streak', /Great/.test(await txt('#h-ci-summary')) && /0\.5 L \/ 0\.5 L/.test(await txt('#h-ci-summary')) && /Running · 30 min/.test(await txt('#h-ci-summary')) && (await txt('#h-weight')) === '71.5 kg' && (await txt('#h-streak')).toLowerCase() === '1 day streak');
await nav('s-progress');
await page.waitForTimeout(1000); // stat count-up settles
check('Progress: stats', (await txt('#p-now')) === '71.5' && (await txt('#st-checkins')) === '1 of 30' && (await txt('#st-workouts')) === '1');
await nav('s-journey');
check('Journey: today complete', (await page.locator('#j-cal .cal-day.today.c').count()) === 1);
await page.click('#j-cal .cal-day.today');
await page.waitForFunction(() => document.getElementById('j-detail-inner').innerText.includes('Checked in'));
const det = await txt('#j-detail-inner');
check('Journey day detail: weight, exercise, meals, note', det.includes('71.5 kg') && det.includes('Running · 30 min') && det.includes('Lentils') && det.includes('Live test note'));
await nav('s-ach');
check('Achievements: 1 unlocked (First Step)', (await page.locator('.ach:not(.locked)').count()) === 1);

section('Edit the same day: update, not duplicate; meal replacement');
await nav('s-home');
await page.click('#h-checkin-card');
await page.click('#ci-meal-dinner .meal-del');
await page.click('#ci-meal-dinner .mini-btn:not(.ghost2)');
await page.click('.quickadd button:nth-child(2)');
await page.click('#ci-save-btn');
await page.waitForSelector('#ov-celebrate.show');
await page.click('#ov-celebrate .btn');
await page.waitForSelector('#s-home.active');
db = await dbView();
check('DB: still one check-in; water 1.0 L; dinner meal removed, breakfast kept', db.checkins.length === 1 && db.checkins[0].water_ml === 1000 && db.meals.length === 1 && db.meals[0].category === 'breakfast');

section('Logout -> Login -> Reload');
await nav('s-home');
await page.click('[data-action="open-profile"]');
await page.click('[data-action="logout"]');
await page.click('#lo-confirm');
await page.waitForSelector('#s-landing.active');
check('logged out (landing, nav hidden)', !(await page.isVisible('#nav')));
await page.reload();
await page.waitForSelector('#s-landing.active');
check('reload after logout stays logged out (no session leak)', true);
await page.click('#s-landing [data-target="s-login"]');
await page.fill('#li-email', email);
await page.fill('#li-pass', PASS);
await page.click('#s-login [data-action="login"]');
await page.waitForSelector('#s-home.active');
check('login again lands on Home with all data', (await txt('#h-name')) === 'Live UI Tester' && /water\s*1 L \/ 0\.5 L/i.test(await txt('#h-ci-summary')) && (await txt('#h-weight')) === '71.5 kg');
await nav('s-ach');
check('achievements remain after login', (await page.locator('.ach:not(.locked)').count()) === 1);
await page.reload();
await page.waitForSelector('#s-home.active');
check('reload while logged in: session + data remain', /water\s*1 L \/ 0\.5 L/i.test(await txt('#h-ci-summary')) && (await txt('#h-daylabel')) === 'DAY 1 OF 60');
await page.click('#h-checkin-card');
check('reload: saved values restored into the editor (weight, meal, exercise, note)', (await page.inputValue('#ci-weight')) === '71.5' && (await page.locator('#ci-meal-breakfast .meal-item').count()) === 1 && (await page.inputValue('#ci-ex-dur')) === '30' && (await page.inputValue('#ci-notes')) === 'Live test note');

check('no uncaught errors or console errors during the whole flow', problems.length === 0, problems.join(' | '));
await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
process.exit(0);
