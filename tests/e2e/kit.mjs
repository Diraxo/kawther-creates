// Shared harness for the live (real Supabase) browser tests: dev server, browser, throw-away accounts seeded
// through the app's own SupabaseRepository, and an independent database reader.
import '../live/env.mjs';
import { URL_, KEY, testEmail } from '../live/env.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../../src/data/supabaseRepository.js';
import { addDays, todayStr } from '../../src/domain/dates.js';

export { URL_, KEY, testEmail, addDays };
export const PASS = 'Test-pass-12345';
export const today = todayStr();

export function mkChecks() {
  let passed = 0;
  const failures = [];
  const notVerified = [];
  return {
    check(name, cond, detail = '') {
      if (cond) { passed++; console.log('  ✓', name); } else { failures.push(name); console.log('  ✗', name, detail); }
    },
    notVerified(name, why) { notVerified.push(`${name} — ${why}`); console.log('  ?', 'NOT VERIFIED:', name, '—', why); },
    section: (t) => console.log('\n' + t),
    summary() {
      console.log(`\n${passed} passed, ${failures.length} failed, ${notVerified.length} not verified`);
      if (notVerified.length) console.log('NOT VERIFIED:\n - ' + notVerified.join('\n - '));
      if (failures.length) console.log('FAILED:\n - ' + failures.join('\n - '));
      return failures.length === 0;
    },
  };
}

export async function startApp(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], {
    env: { ...process.env, VITE_SUPABASE_URL: URL_, VITE_SUPABASE_ANON_KEY: KEY }, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 4500));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  return {
    BASE: `http://localhost:${port}`,
    browser,
    async stop() { await browser.close(); server.kill(); },
  };
}

export const mkRepo = () => new SupabaseRepository({ url: URL_, anonKey: KEY });

const emptyMeals = () => ({ breakfast: [], lunch: [], dinner: [], snacks: [] });
export const ci = (o = {}) => ({ mood: 'good', weight: null, water: 2000, meals: emptyMeals(), exercise: null, notes: '', ...o });

/**
 * A real account in the real project (signUp -> createJourney -> saveCheckin per seeded day) using the app's own repository.
 * checkins: { [daysAgo]: checkin }
 */
export async function seedAccount(tag, { name = 'Ux Tester', startOffset = 0, duration = 60, startWeight = 72, goalWeight = 62, waterGoal = 2500, checkins = {} } = {}) {
  const repo = mkRepo();
  const email = testEmail(tag);
  await repo.signUp({ name, email, password: PASS });
  await repo.createJourney({ start: addDays(today, -startOffset), duration, startWeight, goalWeight, waterGoal });
  for (const [ago, c] of Object.entries(checkins)) await repo.saveCheckin(addDays(today, -Number(ago)), c);
  await repo.signOut();
  return { email, name, pass: PASS, start: addDays(today, -startOffset), duration };
}

export async function newPage(browser, { width = 390, height = 844, reducedMotion, problems = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await ctx.newPage();
  // Let entrance animations (cards fade/slide in) finish so screenshots show the settled UI.
  const shoot = page.screenshot.bind(page);
  page.screenshot = async (o) => { await page.waitForTimeout(800); return shoot(o); };
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_INTERNET|Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });
  return page;
}

export async function uiLogin(page, BASE, email, pass = PASS) {
  await page.goto(BASE);
  await page.waitForSelector('#s-landing.active');
  await page.click('#s-landing [data-target="s-login"]');
  await page.fill('#li-email', email);
  await page.fill('#li-pass', pass);
  await page.click('#s-login [data-action="login"]');
  await page.waitForSelector('#s-home.active', { timeout: 15000 });
}

// textContent (not innerText): CSS text-transform (e.g. the uppercase streak chip) must not change what we compare.
export const txt = (page, sel) => page.locator(sel).first().evaluate((e) => e.textContent.trim());

/** Independent read of the user's rows with a brand-new client (so we test the database, not the UI's memory). */
export async function dbView(email, pass = PASS) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: pass });
  if (error) throw error;
  const q = async (t) => (await c.from(t).select('*')).data;
  const out = { checkins: await q('checkins'), meals: await q('checkin_meals'), ach: await q('user_achievements'), journey: await q('journeys') };
  await c.auth.signOut();
  return out;
}

/** Does the live project have the movement journal migration (2026-10-01)? Decides PASS vs NOT VERIFIED for detail persistence. */
export async function hasMovementColumns() {
  const repo = mkRepo();
  await repo.signUp({ name: 'Probe', email: testEmail('probe'), password: PASS });
  const { error } = await repo.sb.from('checkins').select('exercise_steps').limit(1);
  await repo.signOut();
  return !error;
}
