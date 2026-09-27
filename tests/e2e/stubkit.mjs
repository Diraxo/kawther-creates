// Deterministic browser harness for the app-lifecycle tests: the REAL app (vite dev server) against an in-memory stand-in
// for the Supabase HTTP API, installed at the network boundary with Playwright routing. No app code is mocked, no live
// project is touched, and latency / failures / offline are fully controllable (slow Supabase, 500s, dropped connection).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

export const HOST = 'stub.supabase.co';
export const SUPA = `https://${HOST}`;
const STORAGE_KEY = 'sb-stub-auth-token';
export const PASS = 'Test-pass-12345';

export function mkChecks() {
  let passed = 0;
  const failures = [];
  const skipped = [];
  return {
    check(name, cond, detail = '') {
      if (cond) { passed++; console.log('  ✓', name); } else { failures.push(name); console.log('  ✗', name, detail); }
    },
    notVerified(name, why) { skipped.push(`${name} — ${why}`); console.log('  ?', 'NOT VERIFIED:', name, '—', why); },
    section: (t) => console.log('\n' + t),
    summary() {
      console.log(`\n${passed} passed, ${failures.length} failed, ${skipped.length} not verified`);
      if (skipped.length) console.log('NOT VERIFIED:\n - ' + skipped.join('\n - '));
      if (failures.length) console.log('FAILED:\n - ' + failures.join('\n - '));
      return failures.length === 0;
    },
  };
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, email) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, email, aal: 'aal1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400, session_id: 'stub-session' })}.sig`;
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const dayStr = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The in-memory "database" plus the knobs a test turns. */
export class Stub {
  accounts = new Map();
  n = 0;
  delay = 0; // ms added to every Supabase response
  dropped = false; // true -> the connection is dead: every Supabase request fails like a real network drop
  failStatus = null; // e.g. 500 -> every REST/RPC call (and password login) fails
  grant = []; // achievements the save_checkin RPC grants: [{ id, on }]
  requests = []; // [{ method, path }]
  saves = []; // every save_checkin payload the app sent: [{ date, payload }]
  count = (re) => this.requests.filter((r) => re.test(r.method + ' ' + r.path)).length;

  /** Adds an account. checkins: { [daysAgo]: { weight, water, mood, ... } }; journey null = not onboarded yet. */
  account({ email = `t${this.n + 1}@example.com`, name = 'Kawthar Test', journey = { startOffset: 0, duration: 60, startWeight: 72, goalWeight: 62, waterGoal: 2500 }, checkins = {} } = {}) {
    const id = uid(++this.n);
    const acct = { id, email, name, pass: PASS, onboarded: !!journey, journeys: [], checkins: {}, meals: [], ach: [] };
    if (journey) {
      acct.journeys.push({ start_date: dayStr(-journey.startOffset), duration_days: journey.duration, start_weight: journey.startWeight, goal_weight: journey.goalWeight, water_goal_ml: journey.waterGoal, completed_on: null, post_goal_mode: null, next_goal_weight: null });
    }
    this.accounts.set(email, acct);
    Object.entries(checkins).forEach(([ago, c]) => this.putCheckin(acct, dayStr(-Number(ago)), c));
    return acct;
  }

  putCheckin(acct, date, c) {
    const row = acct.checkins[date] || { id: this.n * 1000 + Object.keys(acct.checkins).length + 1, checkin_date: date };
    Object.assign(row, {
      mood: c.mood ?? null, weight_kg: c.weight ?? null, water_ml: c.water ?? 0,
      exercise_type: c.exercise_type ?? null, exercise_minutes: c.exercise_minutes ?? null, exercise_unit: c.exercise_unit ?? 'minutes', notes: c.notes ?? '',
      exercise_muscles: c.exercise_muscles ?? [], exercise_distance_mi: c.exercise_distance_mi ?? null, exercise_steps: c.exercise_steps ?? null,
      exercise_description: c.exercise_description ?? '',
    });
    acct.checkins[date] = row;
    acct.meals = acct.meals.filter((m) => m.checkin_id !== row.id);
    (c.meals || []).forEach((m, position) => acct.meals.push({ id: acct.meals.length + 1, checkin_id: row.id, category: m.category, name: m.name, notes: m.notes || '', eaten_at: m.eaten_at, position }));
    return row;
  }

  session(acct) {
    const t = jwt(acct.id, acct.email);
    return { access_token: t, token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, refresh_token: 'stub-refresh', user: { id: acct.id, aud: 'authenticated', role: 'authenticated', email: acct.email, factors: [], app_metadata: {}, user_metadata: { full_name: acct.name }, created_at: new Date().toISOString() } };
  }

  byToken(req) {
    const m = /Bearer ([^\s]+)/.exec(req.headers().authorization || '');
    if (!m) return null;
    let sub;
    try { sub = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString()).sub; } catch { return null; }
    return [...this.accounts.values()].find((a) => a.id === sub) || null;
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (this.dropped) return route.abort('connectionfailed');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    this.requests.push({ method: req.method(), path: url.pathname });
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const isAuth = url.pathname.startsWith('/auth/v1/');
    if (this.failStatus && (!isAuth || url.pathname.includes('/token'))) return json(this.failStatus, { message: 'stub failure' });

    const body = req.postData() ? JSON.parse(req.postData()) : {};
    if (url.pathname === '/auth/v1/token') {
      const a = this.accounts.get(String(body.email || '').toLowerCase());
      if (!a || a.pass !== body.password) return json(400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });
      return json(200, this.session(a));
    }
    if (url.pathname === '/auth/v1/signup') {
      if (this.accounts.has(body.email)) return json(200, { id: 'x', identities: [] });
      const a = this.account({ email: body.email, name: (body.data || {}).full_name || 'New', journey: null });
      a.pass = body.password;
      return json(200, this.session(a));
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/auth/v1/user') {
      const a = this.byToken(req);
      return a ? json(200, this.session(a).user) : json(401, { message: 'invalid jwt' });
    }
    if (isAuth) return json(200, {});

    const a = this.byToken(req);
    if (!a) return json(401, { code: 'PGRST301', message: 'JWT expired' });
    const one = /pgrst\.object/.test(req.headers().accept || '');
    const reply = (rows) => (one ? (rows.length ? json(200, rows[0]) : json(406, { code: 'PGRST116', message: 'no rows' })) : json(200, rows));
    const t = url.pathname.replace('/rest/v1/', '');
    if (t === 'profiles') return reply([{ id: a.id, full_name: a.name, onboarded: a.onboarded }]);
    if (t === 'journeys') return reply(a.journeys);
    if (t === 'checkins') return reply(Object.values(a.checkins));
    if (t === 'checkin_meals') return reply(a.meals);
    if (t === 'user_achievements') return reply(a.ach.map((x) => ({ achievement_id: x.id, unlocked_on: x.on })));
    if (t === 'rpc/create_journey') {
      a.journeys = [{ start_date: body.p_start, duration_days: body.p_duration, start_weight: body.p_start_weight, goal_weight: body.p_goal_weight, water_goal_ml: body.p_water_goal, completed_on: null, post_goal_mode: null, next_goal_weight: null }];
      a.onboarded = true;
      return json(200, { ok: true });
    }
    if (t === 'rpc/save_checkin') {
      const p = body.p_checkin;
      this.putCheckin(a, body.p_date, { mood: p.mood, weight: p.weight_kg, water: p.water_ml, exercise_type: p.exercise_type, exercise_minutes: p.exercise_minutes, exercise_unit: p.exercise_unit, exercise_muscles: p.exercise_muscles, exercise_distance_mi: p.exercise_distance_mi, exercise_steps: p.exercise_steps, exercise_description: p.exercise_description, notes: p.notes, meals: p.meals });
      this.saves.push({ date: body.p_date, payload: p });
      const unlocked = this.grant;
      unlocked.forEach((g) => a.ach.push(g));
      return json(200, { ok: true, unlocked });
    }
    if (t === 'rpc/update_water_goal') { a.journeys[0].water_goal_ml = body.p_ml; return json(200, { ok: true }); }
    if (t === 'rpc/claim_journey_complete') return json(200, { ok: true, unlocked: [] });
    return json(404, { message: `stub: unhandled ${t}` });
  }
}

export async function startApp(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], {
    env: { ...process.env, VITE_SUPABASE_URL: SUPA, VITE_SUPABASE_ANON_KEY: 'stub-anon-key', VITE_TURNSTILE_SITE_KEY: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  return { BASE: `http://localhost:${port}`, browser, async stop() { await browser.close(); server.kill(); } };
}

/**
 * A fresh browser context wired to `stub`. `signedIn`: an account whose session is already stored (a returning user,
 * exactly what an installed PWA has on a warm launch).
 */
export async function newSession(app, stub, { signedIn = null, width = 390, height = 844, reducedMotion, offline = false } = {}) {
  const ctx = await app.browser.newContext({ viewport: { width, height }, reducedMotion, deviceScaleFactor: 2 });
  await ctx.route(`${SUPA}/**`, (r) => stub.handle(r).catch(() => {}));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (signedIn) await ctx.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, [STORAGE_KEY, JSON.stringify(stub.session(signedIn))]);
  if (offline) await ctx.setOffline(true);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  return { ctx, page, problems };
}

export const txt = (page, sel) => page.locator(sel).first().evaluate((e) => e.textContent.trim());
