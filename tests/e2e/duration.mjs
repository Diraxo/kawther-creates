// Journey-length picker, live: validation cases in the real onboarding UI, then real accounts that pick
// presets / custom values and are verified in Supabase (separate client), Home, Journey, reload and logout -> login.
//   node tests/e2e/duration.mjs   (needs .env; Auth "Confirm email" OFF; the 7..365 DB migration applied)
import '../live/env.mjs';
import { URL_, KEY, testEmail } from '../live/env.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

let passed = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { passed++; console.log('  ✓', n); } else { failures.push(n); console.log('  ✗', n, d); } };

const PORT = 5177;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, VITE_DATA_BACKEND: 'supabase', VITE_SUPABASE_URL: URL_, VITE_SUPABASE_ANON_KEY: KEY }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 4500));
const BASE = `http://localhost:${PORT}`;
const PASS = 'Test-pass-12345';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const problems = [];

async function newPage(w = 390) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  return page;
}
const txt = (page, sel) => page.locator(sel).first().evaluate((e) => (e.innerText ?? e.textContent).trim());
async function dbJourney(email) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  const { data } = await c.from('journeys').select('*');
  await c.auth.signOut();
  return data;
}
async function toDurStep(page, email) {
  await page.goto(BASE);
  await page.waitForSelector('#s-landing.active');
  await page.click('#s-landing [data-target="s-signup"]');
  await page.fill('#su-name', 'Duration Tester');
  await page.fill('#su-email', email);
  await page.fill('#su-pass', PASS);
  await page.fill('#su-pass2', PASS);
  await page.click('#s-signup [data-action="signup"]');
  await page.waitForSelector('#s-ob1.active', { timeout: 15000 });
  await page.click('#s-ob1 .btn');
  await page.fill('#ob-start', '72');
  await page.click('#s-ob2 .btn');
  await page.fill('#ob-goal', '62');
  await page.click('#s-ob3 .btn');
  await page.waitForSelector('#s-ob4.active');
}
const finishBtn = '#s-ob4 [data-action="finish-onboarding"]';
const onStep = async (page) => (await page.locator('#s-ob4.active').count()) === 1;

console.log('\nValidation in the picker UI');
const email = testEmail('dur');
const page = await newPage();
await toDurStep(page, email);
check('presets show subtitles and 90 is pre-selected', (await txt(page, '#s-ob4 [data-d="30"]')).includes('A focused start') && (await page.getAttribute('#s-ob4 [data-d="90"]', 'aria-pressed')) === 'true');
check('custom body hidden until Custom is chosen', await page.locator('#ob-dur').isHidden());
await page.click('#s-ob4 [data-d="custom"]');
check('Custom reveals the input and is aria-pressed', (await page.locator('#ob-dur').isVisible()) && (await page.getAttribute('#s-ob4 [data-d="custom"]', 'aria-pressed')) === 'true' && (await page.getAttribute('#s-ob4 [data-d="90"]', 'aria-pressed')) === 'false');
const err = () => txt(page, '#e-ob-dur');
const errVisible = () => page.locator('#e-ob-dur').isVisible();
for (const [input, msg] of [['6', 'Choose at least 7 days.'], ['0', 'Choose at least 7 days.'], ['366', 'Your journey can be up to 365 days.']]) {
  await page.fill('#ob-dur', input);
  check(`"${input}" rejected inline`, (await err()) === msg && (await errVisible()));
  await page.click(finishBtn);
  check(`"${input}" cannot be submitted`, await onStep(page));
}
await page.fill('#ob-dur', '');
await page.click(finishBtn);
check('empty custom value rejected', (await err()) === 'Enter how many days.' && (await onStep(page)));
await page.fill('#ob-dur', '');
await page.type('#ob-dur', 'abc');
check('letters are not accepted into the field', (await page.inputValue('#ob-dur')) === '');
await page.fill('#ob-dur', '');
await page.type('#ob-dur', '4.5');
check('decimal point cannot be typed (only digits kept)', (await page.inputValue('#ob-dur')) === '45');
await page.fill('#ob-dur', '');
await page.type('#ob-dur', '-10');
check('minus sign cannot be typed (negative impossible)', (await page.inputValue('#ob-dur')) === '10');
await page.fill('#ob-dur', '7');
check('7 accepted (no error)', !(await errVisible()));
await page.fill('#ob-dur', '365');
check('365 accepted (no error)', !(await errVisible()));
await page.fill('#ob-dur', '7');
await page.click('.dur-step[data-n="-1"]');
check('minus stops at 7', (await page.inputValue('#ob-dur')) === '7');
await page.fill('#ob-dur', '365');
await page.click('.dur-step[data-n="1"]');
check('plus stops at 365', (await page.inputValue('#ob-dur')) === '365');
await page.fill('#ob-dur', '44');
await page.click('.dur-step[data-n="1"]');
check('plus adds a day', (await page.inputValue('#ob-dur')) === '45');
check('no horizontal overflow at 390', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await page.setViewportSize({ width: 320, height: 640 });
check('no horizontal overflow at 320 with custom open', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
const box = await page.locator('#ob-dur').boundingBox();
const step = await page.locator('.dur-step').first().boundingBox();
check('custom input and steppers usable at 320px', box.width >= 60 && step.width >= 44 && step.height >= 44, JSON.stringify({ box, step }));

console.log('\nReal account: Custom 45');
await page.setViewportSize({ width: 390, height: 844 });
await page.click(finishBtn);
await page.waitForSelector('#s-success.active');
check('success screen says 45 DAYS', (await txt(page, '#suc-days')) === '45 DAYS');
await page.click('#s-success .btn');
await page.waitForSelector('#s-home.active');
check('Home shows DAY 1 OF 45', (await txt(page, '#h-daylabel')) === 'DAY 1 OF 45');
const j = await dbJourney(email);
check('Supabase journeys.duration_days = 45', j.length === 1 && j[0].duration_days === 45, JSON.stringify(j));
await page.click('.navbtn[data-s="s-journey"]');
check('Journey has exactly 45 days', (await page.locator('#j-cal .cal-day:not(.empty)').count()) === 45 && (await txt(page, '#j-daylabel')) === 'Day 1 / 45');
await page.reload();
await page.waitForSelector('#s-home.active');
check('reload: still DAY 1 OF 45', (await txt(page, '#h-daylabel')) === 'DAY 1 OF 45');
await page.click('[data-action="open-profile"]');
check('Profile shows 45 days', (await txt(page, '#pf-journey')) === '45 days');
await page.click('[data-action="logout"]');
await page.click('#lo-confirm');
await page.waitForSelector('#s-landing.active');
await page.click('#s-landing [data-target="s-login"]');
await page.fill('#li-email', email);
await page.fill('#li-pass', PASS);
await page.click('#s-login [data-action="login"]');
await page.waitForSelector('#s-home.active');
check('logout then login: still DAY 1 OF 45', (await txt(page, '#h-daylabel')) === 'DAY 1 OF 45');

console.log('\nPresets and other custom values persist exactly (real accounts)');
for (const [label, pick, want] of [['30', '30', 30], ['60', '60', 60], ['90', '90', 90], ['custom 7', 7, 7], ['custom 120', 120, 120], ['custom 365', 365, 365]]) {
  const e = testEmail('dur' + label.replace(/\W/g, ''));
  const p = await newPage();
  await toDurStep(p, e);
  if (typeof pick === 'string') await p.click(`#s-ob4 [data-d="${pick}"]`);
  else { await p.click('#s-ob4 [data-d="custom"]'); await p.fill('#ob-dur', String(pick)); }
  await p.click(finishBtn);
  await p.waitForSelector('#s-success.active');
  await p.click('#s-success .btn');
  await p.waitForSelector('#s-home.active');
  const d = await dbJourney(e);
  check(`${label}: Home DAY 1 OF ${want}, DB ${want}`, (await txt(p, '#h-daylabel')) === `DAY 1 OF ${want}` && d[0].duration_days === want);
  await p.click('.navbtn[data-s="s-journey"]');
  check(`${label}: Journey has ${want} days`, (await p.locator('#j-cal .cal-day:not(.empty)').count()) === want);
  await p.context().close();
}

console.log('\nDatabase constraint boundaries (real Supabase, direct writes as the account owner)');
{
  const c = createClient(URL_, KEY, { auth: { persistSession: false } });
  const { error: se } = await c.auth.signInWithPassword({ email, password: PASS });
  if (se) throw se;
  let cur = 45;
  for (const [n, ok] of [[7, true], [365, true], [6, false], [366, false], [45, true]]) {
    const { data, error } = await c.from('journeys').update({ duration_days: n }).gt('duration_days', 0).select();
    const stored = (await c.from('journeys').select('duration_days')).data?.[0]?.duration_days;
    if (ok) cur = n;
    check(`DB ${ok ? 'accepts' : 'rejects'} ${n}`, ok ? !error && data?.[0]?.duration_days === n && stored === n : !!error && stored === cur, JSON.stringify({ error: error?.message, stored }));
  }
  await c.auth.signOut();
}

check('no uncaught errors', problems.length === 0, problems.join(' | '));
await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
process.exit(0);
