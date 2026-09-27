// Goal Achievement Experience, driven in a real browser against an in-memory MOCK of Supabase (no network, no real project).
// A 60-day journey, 48 -> 65 kg, on Day 30: saving a 65 kg check-in must run the full celebration, persist the goal
// achievement, and then let her choose what comes next. Screenshots go to $GOAL_SHOTS (default: the OS temp dir).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, todayStr } from '../../src/domain/dates.js';
import { findNewUnlocks } from '../../src/domain/achievements.js';
import { goalAchievement } from '../../src/domain/goal.js';
import { isJourneyEnded } from '../../src/domain/journeyComplete.js';

const PORT = 5179;
const MOCK = 'http://mock.local';
const SHOTS = process.env.GOAL_SHOTS || tmpdir();
const today = todayStr();
const uid = '00000000-0000-4000-8000-000000000001';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_ANON_KEY: 'mock-anon-key' }, stdio: 'ignore',
});
const BASE = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  const ok = await fetch(BASE + '/src/main.js').then((r) => r.ok, () => false);
  if (ok) break;
  if (i > 120) throw new Error('vite did not start');
  await new Promise((r) => setTimeout(r, 250));
}

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => { if (cond) { passed++; console.log('  ✓', name); } else { failures.push(name); console.log('  ✗', name, detail); } };

// ---- the mock database
const db = {
  journey: { id: 'j1', user_id: uid, start_date: addDays(today, -29), duration_days: 60, start_weight: 48, goal_weight: 65, water_goal_ml: 2500, post_goal_mode: null, next_goal_weight: null },
  checkins: [],
  achievements: [],
  writes: [],
};
for (let ago = 29; ago >= 1; ago--) {
  db.checkins.push({ id: 'c' + ago, user_id: uid, checkin_date: addDays(today, -ago), mood: 'good', weight_kg: +(48 + (29 - ago) * 0.58).toFixed(1), water_ml: 2000, exercise_type: null, exercise_minutes: null, exercise_unit: 'minutes', notes: '' });
}

async function mockSupabase(ctx) {
  await ctx.route(`${MOCK}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const single = (req.headers().accept || '').includes('vnd.pgrst.object');
    const table = url.pathname.replace('/rest/v1/', '');
    if (url.pathname.startsWith('/auth/v1')) return json({}, 200);
    // The browser has no table-write privilege in the real database; every write is an RPC. This mock plays the SERVER:
    // it applies the write and DERIVES achievements from its own rows with the same rules the SQL implements
    // (tests/integration/security.test.js proves SQL == these rules on 250 random histories).
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop();
      const args = req.postData() ? JSON.parse(req.postData()) : {};
      db.writes.push({ method: 'RPC', table: 'rpc/' + name, body: args });
      const j = db.journey;
      const asUser = () => ({
        journey: { start: j.start_date, duration: j.duration_days, startWeight: j.start_weight, goalWeight: j.goal_weight, waterGoal: j.water_goal_ml },
        checkins: Object.fromEntries(db.checkins.map((c) => [c.checkin_date, { weight: c.weight_kg, water: c.water_ml, exercise: c.exercise_type ? { type: c.exercise_type } : null }])),
        unlocked: db.achievements.map((a) => a.achievement_id),
        unlockedDates: Object.fromEntries(db.achievements.map((a) => [a.achievement_id, a.unlocked_on])),
      });
      const grant = (list, dateOf) => list.map((a) => {
        const on = dateOf(a);
        db.achievements = db.achievements.filter((x) => x.achievement_id !== a.id);
        db.achievements.push({ user_id: uid, achievement_id: a.id, unlocked_on: on });
        return { id: a.id, on };
      });
      if (name === 'save_checkin') {
        const { p_date, p_checkin } = args;
        db.checkins = db.checkins.filter((c) => c.checkin_date !== p_date);
        db.checkins.push({ id: 'c-' + p_date, user_id: uid, checkin_date: p_date, mood: p_checkin.mood, weight_kg: p_checkin.weight_kg, water_ml: p_checkin.water_ml, exercise_type: p_checkin.exercise_type, exercise_minutes: p_checkin.exercise_minutes, exercise_unit: p_checkin.exercise_unit, notes: p_checkin.notes });
        const fresh = findNewUnlocks(asUser(), p_date);
        const unlocked = grant(fresh, (a) => (a.id === 'goal' ? goalAchievement(asUser()).date : p_date));
        return json({ ok: true, id: 'c-' + p_date, unlocked });
      }
      if (name === 'claim_journey_complete') {
        const u = asUser();
        const unlocked = !u.unlocked.includes('journey') && isJourneyEnded(u.journey, today)
          ? grant([{ id: 'journey' }], () => addDays(j.start_date, j.duration_days - 1)) : [];
        return json({ ok: true, unlocked });
      }
      if (name === 'set_post_goal') {
        if (!db.achievements.some((a) => a.achievement_id === 'goal')) return json({ code: 'P0001', message: 'goal not reached' }, 400);
        j.post_goal_mode = args.p_mode;
        j.next_goal_weight = args.p_mode === 'new_goal' ? args.p_next : null;
        return json({ ok: true });
      }
      if (name === 'update_water_goal') { j.water_goal_ml = args.p_ml; return json({ ok: true }); }
      return json({ ok: true });
    }
    if (req.method() === 'GET') {
      const rows = { profiles: [{ id: uid, full_name: 'Kawther Ali', email: 'k@example.com', onboarded: true }], journeys: [db.journey], checkins: db.checkins, checkin_meals: [], user_achievements: db.achievements }[table] || [];
      return json(single ? rows[0] : rows);
    }
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    // Any direct table write is refused, exactly like the real database (no INSERT/UPDATE/DELETE privilege).
    db.writes.push({ method: req.method(), table, body });
    return json({ code: '42501', message: 'permission denied for table ' + table }, 403);
  });
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const problems = [];

async function open({ reducedMotion } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
  await mockSupabase(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_INTERNET|Failed to load resource/.test(m.text())) problems.push('console: ' + m.text()); });
  const session = { access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, email: 'k@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
  await page.addInitScript((s) => localStorage.setItem('sb-mock-auth-token', JSON.stringify(s)), session);
  await page.goto(BASE);
  await page.waitForSelector('#s-home.active');
  return page;
}
/** The ordinary unlocks (streaks etc.) wait for the experience to close, then show one by one. */
async function dismissMilestones(page) {
  let n = 0;
  while (await page.waitForSelector('#ov-milestone.show', { timeout: 2500 }).then(() => true, () => false)) {
    await page.click('#mi-btn');
    n++;
    await page.waitForTimeout(500);
  }
  return n;
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `goal-${name}.png`) });

try {
  console.log('\nBefore the goal: gain goal progress is real (not stuck at 0%)');
  let page = await open();
  await page.waitForTimeout(1300);
  const pctBefore = await page.textContent('#h-pct');
  check('home shows real progress toward a gaining goal', parseInt(pctBefore, 10) > 90, pctBefore);
  check('no goal card yet', await page.locator('#h-goalcard').isHidden());
  check('no overlay yet', !(await page.locator('#ov-reached.show').count()));

  console.log('\nDay 30: log 65 kg');
  await page.click('[data-action="open-checkin"] >> visible=true');
  await page.fill('#ci-weight', '65');
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
  await page.click('#ov-celebrate [data-target="ov-celebrate"]');
  await page.waitForSelector('#ov-reached.show', { timeout: 6000 });
  check('celebration opens on recognition', (await page.getAttribute('#ov-reached .rc', 'data-phase')) === 'recognition');
  await page.waitForTimeout(1500);
  await shot(page, '1-recognition-count');
  await page.waitForTimeout(3500);
  check('big number lands on 65.0', (await page.textContent('#rc-num')) === '65.0', await page.textContent('#rc-num'));
  check('shows GOAL REACHED and 30 DAYS EARLY', (await page.textContent('#ov-reached .rc-l1')) === 'GOAL REACHED' && (await page.textContent('#rc-early')) === '30 DAYS EARLY', await page.textContent('#rc-early'));
  await shot(page, '2-recognition');
  check('goal achievement persisted with the real goal date', db.achievements.some((a) => a.achievement_id === 'goal' && a.unlocked_on === today), JSON.stringify(db.achievements));

  await page.click('#rc-next');
  check('recap phase', (await page.getAttribute('#ov-reached .rc', 'data-phase')) === 'recap');
  check('recap copy', (await page.textContent('#rc-range')) === '48.0 → 65.0' && (await page.textContent('#rc-change')) === '+17.0 kg' && (await page.textContent('#rc-pct')) === '50% of your journey completed');
  await page.waitForTimeout(5200);
  await shot(page, '3-recap');

  await page.click('#rc-next');
  check('trophy phase', (await page.getAttribute('#ov-reached .rc', 'data-phase')) === 'trophy');
  check('trophy copy', (await page.textContent('#rc-you')) === 'YOU DID IT, KAWTHER.' && (await page.textContent('#rc-reached')) === 'Goal reached on Day 30' && (await page.textContent('#rc-trophy')) === '30 days ahead of your original 60-day journey');
  await page.waitForTimeout(3200);
  await shot(page, '4-trophy');

  await page.click('#rc-next');
  check('choices phase offers three options and Decide later', (await page.locator('#rc-options .rc-opt').count()) === 3 && (await page.locator('#rc-later').isVisible()));
  check('says how many days are left', (await page.textContent('#rc-left')) === 'You still have 30 days left in your journey.');
  await shot(page, '5-choices');

  console.log('\nDecide later, then choose from Home');
  await page.click('#rc-later');
  check('overlay closed', !(await page.locator('#ov-reached.show').count()));
  check('ordinary unlocks show only AFTER the experience closed', (await dismissMilestones(page)) > 0);
  check('journey was NOT ended or replaced', db.writes.every((w) => w.table !== 'journeys') && db.journey.duration_days === 60);
  check('home goal card appears', await page.locator('#h-goalcard').isVisible() && (await page.textContent('#h-gc-weight')) === '65.0 kg');
  check('home offers the three choices', (await page.locator('#h-gc-next [data-action="goal-choose"]').count()) === 3);
  await shot(page, '6-home');

  await page.click('[data-action="goal-choose"][data-mode="new_goal"]');
  await page.waitForSelector('#rc-newgoal:not([hidden])');
  await page.fill('#rc-newgoal-input', '65');
  await page.click('#rc-newgoal-save');
  check('new goal equal to the reached goal is rejected inline', (await page.textContent('#rc-newgoal-err')).includes('Maintain'));
  await page.fill('#rc-newgoal-input', 'abc');
  await page.click('#rc-newgoal-save');
  check('junk is rejected inline', (await page.textContent('#rc-newgoal-err')).includes('number'));
  await shot(page, '7-newgoal');
  await page.fill('#rc-newgoal-input', '68');
  await page.click('#rc-newgoal-save');
  await page.waitForFunction(() => !document.querySelector('#ov-reached.show'));
  check('new goal saved (mode + weight)', db.journey.post_goal_mode === 'new_goal' && db.journey.next_goal_weight === 68, JSON.stringify(db.journey));
  check('home now tracks the new goal', (await page.textContent('#h-goal-label')) === 'New goal' && (await page.textContent('#h-goal')) === '68 kg');
  check('home shows the chosen focus', (await page.textContent('#h-gc-next')).includes('New goal: 68 kg'));

  console.log('\nMaintain / journal, timeline, profile, achievements');
  await page.click('[data-action="change-goal-focus"]');
  await page.click('#rc-options [data-mode="maintain"]');
  await page.waitForFunction(() => !document.querySelector('#ov-reached.show'));
  check('maintain saved and clears the new goal', db.journey.post_goal_mode === 'maintain' && db.journey.next_goal_weight === null);
  check('home shows maintain focus and original goal target', (await page.textContent('#h-gc-next')).includes('Maintaining 65 kg') && (await page.textContent('#h-goal')) === '65 kg');

  await page.click('.navbtn[data-s="s-journey"]');
  const reached = page.locator('#j-cal .cal-day.reached');
  check('timeline marks Day 30 as the goal day', (await reached.count()) === 1 && (await reached.first().getAttribute('aria-label')).startsWith('Day 30, goal reached'), await reached.first().getAttribute('aria-label'));
  await shot(page, '8-journey');
  await reached.first().click();
  check('day detail says goal reached', (await page.textContent('#j-detail-inner')).includes('Goal reached'));

  await page.click('.navbtn[data-s="s-ach"]');
  check('trophy card is first and unlocked', (await page.locator('#ach-grid .ach').first().getAttribute('class')).includes('trophy') && !(await page.locator('#ach-grid .ach').first().getAttribute('class')).includes('locked'));
  await shot(page, '9-achievements');
  await page.locator('#ach-grid .ach.trophy', { hasText: 'Goal Achieved' }).click();
  await page.waitForSelector('#ov-reached.show');
  check('tapping the trophy replays without choices', (await page.locator('#rc-later').isHidden()));
  await page.click('#rc-skip');
  check('skip goes to the last phase (trophy) and Done closes', (await page.getAttribute('#ov-reached .rc', 'data-phase')) === 'trophy' && (await page.textContent('#rc-next')) === 'Done');
  await page.click('#rc-next');
  check('closed', !(await page.locator('#ov-reached.show').count()));

  await page.click('.navbtn[data-s="s-home"]');
  await page.click('[data-action="open-profile"]');
  check('profile badge', await page.locator('#pf-badge').isVisible() && (await page.textContent('#pf-badge-sub')) === 'Day 30 · 65 kg');
  await shot(page, '10-profile');

  console.log('\nReload keeps everything (state comes from the database)');
  await page.reload();
  await page.waitForSelector('#s-home.active');
  check('goal card after reload', await page.locator('#h-goalcard').isVisible() && (await page.textContent('#h-gc-next')).includes('Maintaining 65 kg'));
  await page.close();

  console.log('\nReduced motion: nothing auto-advances, everything is visible');
  db.achievements = [];
  db.checkins = db.checkins.filter((c) => c.checkin_date !== today);
  db.journey.post_goal_mode = null;
  page = await open({ reducedMotion: 'reduce' });
  await page.click('[data-action="open-checkin"] >> visible=true');
  await page.fill('#ci-weight', '65.4');
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
  await page.waitForSelector('#ov-reached.show');
  await page.waitForTimeout(800);
  check('number is final immediately', (await page.textContent('#rc-num')) === '65.4');
  await page.waitForTimeout(6800);
  check('does not auto-advance', (await page.getAttribute('#ov-reached .rc', 'data-phase')) === 'recognition');
  check('early badge is visible without animation', (await page.locator('#rc-early').evaluate((e) => getComputedStyle(e).opacity)) === '1');
  await page.keyboard.press('Escape');
  check('Escape closes (goal already saved, Home keeps the choice)', !(await page.locator('#ov-reached.show').count()) && db.achievements.some((a) => a.achievement_id === 'goal'));
  await page.close();

  console.log('\nNarrow phone (320px) fits');
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  await mockSupabase(ctx);
  page = await ctx.newPage();
  await page.addInitScript((s) => localStorage.setItem('sb-mock-auth-token', JSON.stringify(s)), { access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, email: 'k@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
  await page.goto(BASE);
  await page.waitForSelector('#s-home.active');
  await page.evaluate(() => document.querySelector('[data-action="celebrate-again"]').click());
  await page.waitForSelector('#ov-reached.show');
  await page.click('#rc-skip');
  await page.waitForTimeout(3500);
  check('no horizontal overflow at 320px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(SHOTS, 'goal-11-320.png') });
} catch (e) {
  failures.push('exception: ' + e.message);
  console.log('  ✗ exception', e.stack);
}

check('no page errors / console errors', problems.length === 0, problems.join(' | '));
await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${SHOTS}`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
