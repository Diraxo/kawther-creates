// Phase 7: real-world failure states, in Supabase mode, in a real browser.
// The app + real supabase-js run for real; only the NETWORK is faked (Playwright routes), because
// failures like "Supabase down" or "JWT expired" cannot be triggered on demand against a live project.
//   node tests/e2e/failures.mjs   (spawns its own vite servers on 5174/5175)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const FAKE = 'http://mock-supabase.test';
let passed = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { passed++; console.log('  ✓', n); } else { failures.push(n); console.log('  ✗', n, d); } };
const section = (t) => console.log('\n' + t);

function vite(port, env) {
  const p = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], { env: { ...process.env, ...env }, stdio: 'ignore' });
  return p;
}
const servers = [
  vite(5174, { VITE_SUPABASE_URL: FAKE, VITE_SUPABASE_ANON_KEY: 'anon-key-for-tests' }),
  vite(5175, { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }),
];
await new Promise((r) => setTimeout(r, 4500));

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
const cors = (route) => route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });

const USER = { id: '99999999-9999-9999-9999-999999999999', aud: 'authenticated', role: 'authenticated', email: 'mock@x.com', user_metadata: { full_name: 'Mock User' }, app_metadata: {}, created_at: '2026-01-01T00:00:00Z', identities: [{}] };
const SESSION = { access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER };
const today = new Date();
const TODAY = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

/** Mock backend. `rpc` decides how save_checkin answers; `signup`/`token` override auth answers. */
async function mock(page, o = {}) {
  await page.route(`${FAKE}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return cors(route);
    if (o.down) return route.abort('connectionrefused');
    const p = url.pathname;
    if (p.endsWith('/auth/v1/token')) return o.token ? o.token(route) : json(route, 200, SESSION);
    if (p.endsWith('/auth/v1/signup')) return o.signup ? o.signup(route) : json(route, 200, { ...SESSION });
    if (p.endsWith('/auth/v1/logout')) return o.logout ? o.logout(route) : json(route, 204, {});
    if (p.endsWith('/auth/v1/user')) return json(route, 200, USER);
    if (p.includes('/rest/v1/rpc/')) { const name = p.split('/').pop(); return (o.rpc && o.rpc[name]) ? o.rpc[name](route) : json(route, 200, null); }
    if (p.endsWith('/rest/v1/profiles')) return json(route, 200, { id: USER.id, full_name: 'Mock User', email: USER.email, onboarded: true });
    if (p.endsWith('/rest/v1/journeys')) return json(route, 200, [{ user_id: USER.id, start_date: TODAY, duration_days: 90, start_weight: 72, goal_weight: 62, water_goal_ml: 2500, completed_on: null }]); // a list since multi-journey history
    if (p.endsWith('/rest/v1/checkins') || p.endsWith('/rest/v1/checkin_meals') || p.endsWith('/rest/v1/user_achievements')) return json(route, 200, []);
    return json(route, 404, { message: 'unmocked ' + p });
  });
}
async function open(url, o) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const uncaught = [];
  page.on('pageerror', (e) => uncaught.push(e.message));
  if (o) await mock(page, o);
  await page.goto(url);
  return { ctx, page, uncaught };
}
const toast = (page) => page.locator('#kc-toast').innerText();
const screen = (page) => page.evaluate(() => document.querySelector('.screen.active')?.id);
async function login(page) {
  await page.click('#s-landing [data-target="s-login"]');
  await page.fill('#li-email', 'mock@x.com');
  await page.fill('#li-pass', 'password1');
  await page.click('#s-login [data-action="login"]');
}
async function toCheckin(page) {
  await page.waitForSelector('#s-home.active');
  await page.click('.navbtn.fab');
  await page.click('#ci-mood .mood[data-m="good"]');
  await page.fill('#ci-weight', '70');
  await page.click('[data-action="adj-water"][data-n="250"]');
  await page.click('[data-action="add-meal"][data-cat="lunch"]');
  await page.fill('#meal-name', 'Soup');
  await page.click('#ov-meal [data-action="confirm-meal"]');
}

section('Missing environment variables');
{
  const { ctx, page, uncaught } = await open('http://localhost:5175');
  await page.waitForSelector('#s-error.active');
  check('explicit "not configured" screen with retry (no silent failure, no fallback data)', /isn't configured/.test(await page.locator('#err-msg').innerText()) && (await page.isVisible('#s-error [data-action="reload"]')));
  check('no demo entry point anywhere', (await page.locator('[data-action="try-demo"]').count()) === 0);
  check('splash removed once the first screen is ready', await page.waitForSelector('#splash', { state: 'detached', timeout: 3000 }).then(() => true, () => false));
  check('no uncaught exceptions', uncaught.length === 0, uncaught.join('|'));
  await ctx.close();
}

section('Supabase unavailable / network failure');
{
  const { ctx, page, uncaught } = await open('http://localhost:5174', { down: true });
  await page.waitForSelector('#s-landing.active');
  await login(page);
  await page.waitForSelector('#e-login', { state: 'visible' });
  check('login: "can\'t reach the server", stays on login', /Can't reach the server/.test(await page.locator('#e-login').innerText()) && (await screen(page)) === 's-login');
  await page.click('#s-login [data-target="s-signup"]');
  await page.fill('#su-name', 'N'); await page.fill('#su-email', 'n@x.com'); await page.fill('#su-pass', 'password1'); await page.fill('#su-pass2', 'password1');
  await page.click('#s-signup [data-action="signup"]');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('e-su-email')).display === 'block');
  check('signup: network error shown, not onboarding', /Can't reach the server/.test(await page.locator('#e-su-email').innerText()) && (await screen(page)) === 's-signup');
  await page.goto('http://localhost:5174'); // reload while offline, nothing stored -> landing, no crash
  await page.waitForSelector('#s-landing.active');
  check('no uncaught exceptions', uncaught.length === 0, uncaught.join('|'));
  await ctx.close();
}

section('Invalid login / duplicate signup');
{
  const { ctx, page } = await open('http://localhost:5174', {
    token: (r) => json(r, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials' }),
    signup: (r) => json(r, 422, { code: 'user_already_exists', error_code: 'user_already_exists', msg: 'User already registered' }),
  });
  await login(page);
  await page.waitForSelector('#e-login', { state: 'visible' });
  check('invalid login -> "Email or password is incorrect."', (await page.locator('#e-login').innerText()) === 'Email or password is incorrect.' && (await screen(page)) === 's-login');
  await page.click('#s-login [data-target="s-signup"]');
  await page.fill('#su-name', 'N'); await page.fill('#su-email', 'dup@x.com'); await page.fill('#su-pass', 'password1'); await page.fill('#su-pass2', 'password1');
  await page.click('#s-signup [data-action="signup"]');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('e-su-email')).display === 'block');
  check('duplicate signup (422 already registered) -> "This account already exists."', (await page.locator('#e-su-email').innerText()) === 'This account already exists.');
  await ctx.close();
}
{
  // Email-confirmation-on projects answer a duplicate signup with a user that has NO identities
  const { ctx, page } = await open('http://localhost:5174', { signup: (r) => json(r, 200, { ...USER, identities: [] }) });
  await page.click('#s-landing [data-target="s-signup"]');
  await page.fill('#su-name', 'N'); await page.fill('#su-email', 'dup@x.com'); await page.fill('#su-pass', 'password1'); await page.fill('#su-pass2', 'password1');
  await page.click('#s-signup [data-action="signup"]');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('e-su-email')).display === 'block');
  check('duplicate signup (confirm-email mode, empty identities) -> exists', (await page.locator('#e-su-email').innerText()) === 'This account already exists.');
  await ctx.close();
}
{
  // Confirm-email ON, new user: no session returned -> must NOT enter the app
  const { ctx, page } = await open('http://localhost:5174', { signup: (r) => json(r, 200, { ...USER }) });
  await page.click('#s-landing [data-target="s-signup"]');
  await page.fill('#su-name', 'N'); await page.fill('#su-email', 'new@x.com'); await page.fill('#su-pass', 'password1'); await page.fill('#su-pass2', 'password1');
  await page.click('#s-signup [data-action="signup"]');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('e-su-email')).display === 'block');
  check('signup needing email confirmation -> "check your inbox", not onboarding', /inbox/.test(await page.locator('#e-su-email').innerText()) && (await screen(page)) === 's-signup');
  await ctx.close();
}

section('Failed check-in save (server error, RLS rejection, network drop, expired session)');
const cases = [
  ['server error 500', (r) => json(r, 500, { message: 'boom', code: 'XX000' }), /Couldn't save your check-in/, 's-checkin'],
  ['RLS/permission rejection 403', (r) => json(r, 403, { code: '42501', message: 'new row violates row-level security policy for table "checkins"' }), /permission/i, 's-checkin'],
  ['meal constraint violation 400 (rolled back server-side)', (r) => json(r, 400, { code: '23514', message: 'new row for relation "checkin_meals" violates check constraint' }), /Couldn't save your check-in/, 's-checkin'],
  ['network drops mid-save', (r) => r.abort('connectionreset'), /Can't reach the server\. Nothing was saved/, 's-checkin'],
  // server-side abuse protection: a clean application result (not a database exception) and nothing pretends to be saved
  ['per-user rate limit hit (clean {ok:false, code:rate_limited})', (r) => json(r, 200, { ok: false, code: 'rate_limited', retry_after: 42 }), /going a little fast/i, 's-checkin'],
  ['server-side validation error (invalid check-in payload)', (r) => json(r, 400, { code: '22023', message: 'invalid check-in payload: notes are too long (max 4000 characters)' }), /Couldn't save your check-in/, 's-checkin'],
];
for (const [name, handler, msg, stays] of cases) {
  // The first save_checkin is the meal being saved as it is added (meals are stored the moment they are confirmed); the failure under
  // test is the check-in save that follows, so only the calls after the first one use the failing handler.
  let calls = 0;
  const rpc = { save_checkin: (r) => (calls++ === 0 ? json(r, 200, { ok: true, unlocked: [] }) : handler(r)) };
  const { ctx, page, uncaught } = await open('http://localhost:5174', { rpc });
  await login(page);
  await toCheckin(page);
  await page.click('#ci-save-btn');
  await page.waitForFunction(() => document.getElementById('kc-toast')?.classList.contains('show'));
  const draftMeals = await page.locator('#ci-meal-lunch .meal-item').count();
  check(`${name}: error toast, no fake "saved"`, msg.test(await toast(page)) && !(await page.isVisible('#ov-celebrate.show')));
  check(`${name}: still on check-in with draft intact, save button re-enabled`, (await screen(page)) === stays && draftMeals === 1 && (await page.isEnabled('#ci-save-btn')) && (await page.locator('#ci-save-btn').innerText()) !== 'Saving…');
  await page.click('#ci-back, #s-checkin .back, #s-checkin [data-action="tab"], #s-checkin [data-action="go"]').catch(() => {});
  check(`${name}: home does NOT show today as complete`, await page.evaluate(() => !document.getElementById('h-checkin-card').classList.contains('done')));
  check(`${name}: no uncaught exceptions`, uncaught.length === 0, uncaught.join('|'));
  await ctx.close();
}
{
  const { ctx, page } = await open('http://localhost:5174', { rpc: { save_checkin: (r) => json(r, 401, { code: 'PGRST301', message: 'JWT expired' }) } });
  await login(page);
  await toCheckin(page);
  await page.click('#ci-save-btn');
  await page.waitForSelector('#s-login.active');
  check('expired session during save -> sent to Log in with a clear message', /session expired/i.test(await toast(page)) && !(await page.isVisible('#nav')));
  await ctx.close();
}
{
  // Successful save is only celebrated AFTER the server confirmed it
  let calls = 0;
  const { ctx, page } = await open('http://localhost:5174', { rpc: { save_checkin: (r) => { calls++; return json(r, 200, 'cid'); } } });
  await login(page);
  await toCheckin(page);
  await page.click('#ci-save-btn');
  await page.waitForSelector('#ov-celebrate.show');
  check('success path: exactly one save_checkin RPC call, then celebration', calls === 1);
  await ctx.close();
}

section('Logout, refresh while logged in, expired session on reload');
{
  const { ctx, page } = await open('http://localhost:5174', {});
  await login(page);
  await page.waitForSelector('#s-home.active');
  await page.reload();
  await page.waitForSelector('#s-home.active');
  check('refresh while logged in restores the session and lands on Home', true);
  await page.click('.navbtn[data-s="s-ach"]');
  await page.click('#s-ach [data-action="go"][data-target="s-profile"], #s-ach [data-action="open-profile"]').catch(() => {});
  await ctx.close();
}
{
  // Server unreachable for /logout: user must still end up logged out locally
  const { ctx, page } = await open('http://localhost:5174', { logout: (r) => r.abort('connectionreset') });
  await login(page);
  await page.waitForSelector('#s-home.active');
  await page.evaluate(() => document.querySelector('[data-action="logout"]').click());
  await page.evaluate(() => document.querySelector('[data-action="confirm-logout"]').click());
  await page.waitForSelector('#s-landing.active');
  check('logout succeeds locally even if the server call fails', true);
  await page.reload();
  await page.waitForSelector('#s-landing.active');
  check('after logout, reload stays logged out', true);
  await ctx.close();
}
{
  // Stored session whose refresh token was revoked/expired -> back to landing, never a half-loaded app
  const { ctx, page } = await open('http://localhost:5174', {});
  await login(page);
  await page.waitForSelector('#s-home.active');
  await page.unroute(`${FAKE}/**`);
  await mock(page, { token: (r) => json(r, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' }), rpc: {} });
  // force the stored token to look expired
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'));
    const v = JSON.parse(localStorage.getItem(k)); v.expires_at = 1; localStorage.setItem(k, JSON.stringify(v));
  });
  await page.reload();
  await page.waitForSelector('#s-landing.active');
  check('expired + unrefreshable session on reload -> landing (logged out), not Home with empty data', (await screen(page)) === 's-landing');
  await ctx.close();
}

await browser.close();
servers.forEach((s) => s.kill());
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
process.exit(0);
