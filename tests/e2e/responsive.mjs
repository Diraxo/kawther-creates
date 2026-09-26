// Responsive + splash + empty-state audit against the REAL Supabase project with a brand-new account.
//   node tests/e2e/responsive.mjs      (needs .env; Auth "Confirm email" OFF; screenshots -> tests/e2e/screenshots)
import '../live/env.mjs';
import { URL_, KEY, testEmail } from '../live/env.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOTS = process.env.SHOTS_DIR || 'tests/e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
let passed = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { passed++; } else { failures.push(n); console.log('  ✗', n, d); } };
const section = (t) => console.log('\n' + t);

const PORT = 5177;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, VITE_SUPABASE_URL: URL_, VITE_SUPABASE_ANON_KEY: KEY }, stdio: 'ignore',
});
const BASE = `http://localhost:${PORT}`;
// Wait until Vite actually serves index.html (with the splash) and main.js compiles, instead of guessing with a fixed sleep.
for (let i = 0; ; i++) {
  const ok = await Promise.all([fetch(BASE).then((r) => r.text()), fetch(BASE + '/src/main.js').then((r) => r.ok)])
    .then(([html, js]) => js && html.includes('id="splash"'), () => false);
  if (ok) break;
  if (i > 120) throw new Error('vite dev server did not become ready');
  await new Promise((r) => setTimeout(r, 250));
}

const SIZES = process.env.QUICK ? [[320, 640], [1280, 800]] : [[320, 640], [360, 740], [375, 667], [390, 844], [414, 896], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]];
const SHOT_W = [320, 390, 768, 1280];
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_INTERNET|Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });

const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** Visible elements of the active screen / nav that poke outside the viewport horizontally. */
const clipped = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('.screen.active *, #nav *, #splash *').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || (e.closest('svg') && e.tagName !== 'svg')) return;
    if (e.closest('.cal-day.empty')) return;
    if (r.left < -1 || r.right > vw + 1) bad.push((e.id || e.className || e.tagName).toString().slice(0, 30));
  });
  return bad.slice(0, 5);
});
const box = (sel) => page.locator(sel).first().boundingBox();
const txt = (sel) => page.locator(sel).first().evaluate((e) => (e.innerText ?? e.textContent).trim());

// ---------- splash: hold main.js so the splash stays on screen, then measure ----------
section('Splash / loading screen');
for (const [w, h] of SIZES) {
  await page.setViewportSize({ width: w, height: h });
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/src/main.js*', async (route) => { await gate; route.continue(); });
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForSelector('#splash .sp-logo', { timeout: 10000 });
  await page.waitForTimeout(900); // entrance animation finished
  const logo = await box('#splash .sp-logo');
  const word = await box('#splash .sp-word');
  const bar = await box('#splash .sp-bar');
  check(`splash logo sized sensibly @${w}`, logo && logo.width >= 60 && logo.width <= 97 && logo.width <= w * 0.3 && Math.abs(logo.height - logo.width) < 1, JSON.stringify(logo));
  check(`splash centered @${w}`, Math.abs(logo.x + logo.width / 2 - w / 2) < 1 && word.y > logo.y + logo.height && bar.y > word.y && bar.y + bar.height < h);
  const sp = await box('#splash');
  check(`splash fills viewport, nothing clipped @${w}`, Math.abs(sp.width - w) < 1 && Math.abs(sp.height - h) < 1 && (await clipped()).length === 0);
  if (SHOT_W.includes(w)) await page.screenshot({ path: `${SHOTS}/splash-${w}.png` });
  release();
  await page.waitForSelector('#s-landing.active');
  check(`splash removed after first screen @${w}`, await page.waitForSelector('#splash', { state: 'detached', timeout: 3000 }).then(() => true, () => false));
  await page.unroute('**/src/main.js*');
}

// ---------- reduced motion: splash must not animate ----------
{
  const rctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage();
  await rp.route('**/src/main.js*', async (route) => { await new Promise((r) => setTimeout(r, 1200)); route.continue(); });
  await rp.goto(BASE, { waitUntil: 'commit' });
  await rp.waitForSelector('#splash .sp-logo');
  const anim = await rp.evaluate(() => ['.sp-logo', '.sp-word', '.sp-bar'].map((s) => getComputedStyle(document.querySelector('#splash ' + s)).animationName));
  check('prefers-reduced-motion: splash animations disabled', anim.every((a) => a === 'none'), anim.join());
  await rctx.close();
}

// ---------- unauthenticated screens ----------
section('Landing / signup / login logos + spacing');
for (const [w, h] of SIZES) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(BASE);
  await page.waitForSelector('#s-landing.active');
  const logo = await box('#s-landing .klogo');
  const cta2 = await box('#s-landing .btn.secondary');
  check(`landing logo ≤ 30% of width & ≤ 104px @${w}`, logo.width <= 104.5 && logo.width <= w * 0.3 && Math.abs(logo.height - logo.width) < 1, JSON.stringify(logo));
  if (w <= 430) check(`landing CTAs visible without scrolling @${w}x${h}`, cta2.y + cta2.height <= h, `bottom=${cta2.y + cta2.height}`);
  check(`landing no overflow/clipping @${w}`, (await overflow()) === 0 && (await clipped()).length === 0, (await clipped()).join());
  check(`landing has no demo entry @${w}`, (await page.locator('text=/demo/i').count()) === 0);
  if (SHOT_W.includes(w)) await page.screenshot({ path: `${SHOTS}/landing-${w}.png` });
  for (const id of ['signup', 'login']) {
    await page.click(`#s-landing [data-target="s-${id}"]`);
    const l = await box(`#s-${id} .klogo`);
    check(`${id} logo ≤ 68px & ≤ 22% width @${w}`, l.width <= 68.5 && l.width <= w * 0.22 + 0.5, JSON.stringify(l));
    check(`${id} no overflow/clipping @${w}`, (await overflow()) === 0 && (await clipped()).length === 0);
    check(`${id} has no demo entry @${w}`, (await page.locator(`#s-${id} >> text=/demo/i`).count()) === 0);
    if (w === 320 || w === 1280) await page.screenshot({ path: `${SHOTS}/${id}-${w}.png` });
    await page.goto(BASE);
    await page.waitForSelector('#s-landing.active');
  }
}

// ---------- fresh real account ----------
section('Fresh account: signup -> onboarding -> EMPTY app');
const email = testEmail('rsp');
const PASS = 'Test-pass-12345';
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE);
await page.click('#s-landing [data-target="s-signup"]');
await page.fill('#su-name', 'Fresh Tester');
await page.fill('#su-email', email);
await page.fill('#su-pass', PASS);
await page.fill('#su-pass2', PASS);
await page.click('#s-signup [data-action="signup"]');
await page.waitForSelector('#s-ob1.active', { timeout: 15000 });
await page.click('#s-ob1 .btn');
await page.fill('#ob-start', '70');
await page.click('#s-ob2 .btn');
await page.fill('#ob-goal', '62');
await page.click('#s-ob3 .btn');
await page.click('#s-ob4 [data-d="30"]');
await page.click('#s-ob4 .btn');
await page.waitForSelector('#s-success.active');
await page.click('#s-success .btn');
await page.waitForSelector('#s-home.active');
check('Home uses the onboarding duration (30), not a hardcoded 90', (await txt('#h-daylabel')) === 'DAY 1 OF 30', await txt('#h-daylabel'));
check('Home: 0 streak, start weight only, 0%', (await txt('#h-streak')).toLowerCase() === 'no streak yet' && (await txt('#h-weight')) === '70.0 kg' && (await txt('#h-pct')) === '0%');
check('Home: first check-in prompt', (await txt('#h-ci-title')) === 'Start your first check-in');
await page.click('.navbtn[data-s="s-progress"]');
check('Progress: empty state + no invented values', (await page.isVisible('#p-empty')) && (await txt('#p-now')) === '—' && (await txt('#st-change')) === '—' && (await txt('#st-streak')) === '0 days' && (await txt('#st-checkins')) === '0 of 30' && (await txt('#st-water')) === '—');
check('Progress: chart has no points, only the empty message', (await page.locator('#p-chart circle').count()) === 0 && /No weigh-ins in this range/.test(await txt('#p-chart')));
await page.click('.navbtn[data-s="s-journey"]');
check('Journey: 30 real days, none completed, future not completed', (await page.locator('#j-cal .cal-day:not(.empty)').count()) === 30 && (await page.locator('#j-cal .cal-day.c, #j-cal .cal-day.p').count()) === 0 && (await page.locator('#j-cal .cal-day.future').count()) === 29);
check('Journey: empty message', /No check-ins yet/.test(await txt('#j-detail-inner')));
await page.click('.navbtn[data-s="s-ach"]');
check('Achievements: none unlocked, empty state shown', (await page.locator('.ach:not(.locked)').count()) === 0 && (await page.isVisible('#ach-empty')));
await page.click('.navbtn[data-s="s-home"]');
await page.click('[data-action="open-profile"]');
check('Profile: real name/email/journey', (await txt('#pf-name')) === 'Fresh Tester' && (await txt('#pf-email')) === email.toLowerCase() && (await txt('#pf-journey')) === '30 days');
await page.click('[data-action="open-share"]');
check('Share card: day 1 and NO invented metrics', (await txt('#sh-day')) === 'DAY 1' && (await page.locator('#sh-rows li:not(.none)').count()) === 0);
await page.click('#ov-share [data-target="ov-share"]');
await page.click('.navbtn[data-s="s-home"]');
await page.click('.navbtn.fab');
check('Check-in: nothing prefilled (no weight, no water, no meals)', (await page.inputValue('#ci-weight')) === '' && (await page.inputValue('#ci-water-input')) === '' && (await page.locator('#s-checkin .meal-item').count()) === 0 && (await page.locator('#s-checkin .meal-empty').count()) === 4);
check('Check-in weight hint = starting weight, not a fake "last logged"', /Starting weight: 70\.0 kg/.test(await txt('#ci-weight-prev')));
await page.click('#s-checkin [data-action="go"]');

// ---------- authenticated screens across widths ----------
section('Authenticated screens across widths');
const screens = [['s-home', 'home'], ['s-progress', 'progress'], ['s-journey', 'journey'], ['s-ach', 'ach'], ['s-profile', 'profile'], ['s-checkin', 'checkin']];
for (const [w, h] of SIZES) {
  await page.setViewportSize({ width: w, height: h });
  for (const [id, name] of screens) {
    if (id === 's-profile') { await page.click('.navbtn[data-s="s-home"]'); await page.click('[data-action="open-profile"]'); }
    else if (id === 's-checkin') await page.click('.navbtn.fab');
    else await page.click(`.navbtn[data-s="${id}"]`);
    await page.waitForSelector(`#${id}.active`);
    await page.waitForTimeout(150);
    check(`${name} no horizontal scroll @${w}`, (await overflow()) === 0);
    const bad = await clipped();
    check(`${name} nothing clipped off-screen @${w}`, bad.length === 0, bad.join());
    const navOk = await page.evaluate(() => {
      const nav = document.getElementById('nav').getBoundingClientRect();
      return parseFloat(getComputedStyle(document.getElementById('app')).paddingBottom) >= nav.height - 1;
    });
    check(`${name} bottom padding clears nav @${w}`, navOk);
    if (SHOT_W.includes(w)) await page.screenshot({ path: `${SHOTS}/${name}-${w}.png` });
    if (id === 's-checkin') await page.click('#s-checkin [data-action="go"]');
  }
  await page.click('.navbtn[data-s="s-home"]');
  const sm = await box('#s-home .klogo--sm');
  check(`home header logo 26–30px @${w}`, sm.width >= 25.5 && sm.width <= 30.5, JSON.stringify(sm));
}

check('no console/page errors', problems.length === 0, problems.join(' | '));
await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
process.exit(0);
