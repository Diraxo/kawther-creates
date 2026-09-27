// Security-relevant behaviour of the browser side: Turnstile wiring (configured / unconfigured), RPC-only writes,
// clean rate-limit errors, MFA routing, session handling, and static guards against secrets and direct table writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCaptcha, TURNSTILE_SRC } from '../../src/lib/turnstile.js';
import { SupabaseRepository } from '../../src/data/supabaseRepository.js';
import { AuthError, classifyError } from '../../src/data/errors.js';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const walk = (dir) => readdirSync(new URL(dir, ROOT)).flatMap((f) => {
  const rel = `${dir}${f}`;
  return statSync(new URL(rel, ROOT)).isDirectory() ? walk(rel + '/') : [rel];
});

// ---------------------------------------------------------------- Turnstile
function fakeDom() {
  const el = (tag) => ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; } });
  const body = { children: [], appendChild(c) { this.children.push(c); } };
  return { createElement: el, body, head: body };
}

test('turnstile UNCONFIGURED: no site key -> disabled, no script, no widget, and NO token is faked', async () => {
  for (const siteKey of [undefined, '', '   ', null]) {
    let loaded = 0;
    const c = createCaptcha({ siteKey, doc: fakeDom(), win: {}, load: async () => { loaded++; } });
    assert.equal(c.enabled, false);
    assert.equal(await c.getToken('signup'), undefined);
    assert.equal(loaded, 0, 'Cloudflare script is never loaded without a site key');
  }
});

test('turnstile CONFIGURED: renders an invisible-unless-needed widget with the site key + action, returns the real token, then removes it', async () => {
  const doc = fakeDom();
  const removed = [];
  let opts;
  const api = { render(host, o) { opts = { host, ...o }; setTimeout(() => o.callback('real-token-123'), 0); return 'w1'; }, remove: (id) => removed.push(id) };
  const c = createCaptcha({ siteKey: '0x4AAAAAAA-site-key', doc, win: {}, load: async () => api });
  assert.equal(c.enabled, true);
  assert.equal(await c.getToken('login'), 'real-token-123');
  assert.equal(opts.sitekey, '0x4AAAAAAA-site-key');
  assert.equal(opts.action, 'login');
  assert.equal(opts.appearance, 'interaction-only');
  assert.deepEqual(removed, ['w1'], 'a token is single-use: the widget is torn down');
  assert.equal(opts.host.removed, true);
  opts['before-interactive-callback']();
  assert.equal(opts.host.style.display, 'block', 'shown only when Cloudflare needs a click');
  assert.match(TURNSTILE_SRC, /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
});

test('turnstile failures surface as AuthError CAPTCHA (never a silent pass)', async () => {
  const api = { render: (h, o) => { setTimeout(() => o['error-callback'](), 0); return 'w'; }, remove() {} };
  await assert.rejects(createCaptcha({ siteKey: 'k', doc: fakeDom(), win: {}, load: async () => api }).getToken('signup'), (e) => e instanceof AuthError && e.code === 'CAPTCHA');
  await assert.rejects(createCaptcha({ siteKey: 'k', doc: fakeDom(), win: {}, load: async () => { throw new Error('blocked'); } }).getToken('signup'), (e) => e.code === 'CAPTCHA');
});

// ---------------------------------------------------------------- repository behaviour with a fake Supabase client
function repoWith(sb, captcha) {
  const r = new SupabaseRepository({ url: 'http://x.test', anonKey: 'anon', captcha });
  r.sb = sb;
  return r;
}
const session = { data: { session: { user: { id: 'u1', email: 'a@x.com' } } }, error: null };
const authStub = { getSession: async () => session };

test('every write is an RPC: the repository never issues a direct table insert/update/upsert/delete', async () => {
  const calls = [];
  const from = () => new Proxy({}, { get: (_, m) => { calls.push(m); return () => { throw new Error('direct table access: ' + m); }; } });
  const rpc = async (name, args) => { calls.push('rpc:' + name); return { data: { ok: true, unlocked: [] }, error: null }; };
  const r = repoWith({ auth: authStub, from, rpc });
  await r.createJourney({ start: '2026-09-26', duration: 30, startWeight: 70, goalWeight: 65, waterGoal: 2500 });
  await r.updateWaterGoal(3000);
  await r.setPostGoal('maintain');
  await r.saveCheckin('2026-09-26', { mood: 'good', weight: 70, water: 2000, meals: { breakfast: [], lunch: [], dinner: [], snacks: [] }, exercise: null, notes: '' });
  await r.claimJourneyComplete();
  await r.startNextJourney({ start: '2026-10-30', duration: 30, startWeight: 70, goalWeight: 65, waterGoal: 2500 }, 'journal');
  assert.deepEqual(calls, ['rpc:create_journey', 'rpc:update_water_goal', 'rpc:set_post_goal', 'rpc:save_checkin', 'rpc:claim_journey_complete', 'rpc:start_next_journey']);
  assert.equal(typeof r.unlockAchievement, 'undefined', 'there is no client-side "unlock achievement" any more');
});

test('no source file writes to a table directly, or stores/reads secrets', () => {
  const src = walk('src/').filter((f) => f.endsWith('.js'));
  for (const f of src) {
    const text = read(f);
    assert.doesNotMatch(text, /\.from\(\s*['"][a-z_]+['"]\s*\)\s*\.\s*(insert|update|upsert|delete)\b/, `${f}: direct table write`);
    assert.doesNotMatch(text, /service_role|SERVICE_ROLE|sb_secret|TURNSTILE_SECRET/, `${f}: server secret referenced`);
  }
});

test('RPC results: rate limits become AuthError RATE_LIMITED with retryAfter; validation errors stay classified; server unlocks are mapped', async () => {
  const limited = repoWith({ auth: authStub, rpc: async () => ({ data: { ok: false, code: 'rate_limited', retry_after: 17 }, error: null }) });
  await assert.rejects(limited.saveCheckin('2026-09-26', { meals: {} }), (e) => e instanceof AuthError && e.code === 'RATE_LIMITED' && e.retryAfter === 17);
  await assert.rejects(limited.createJourney({}), (e) => e.code === 'RATE_LIMITED');
  const bad = repoWith({ auth: authStub, rpc: async () => ({ data: null, error: { message: 'invalid check-in payload: too many meals', code: '22023' } }) });
  await assert.rejects(bad.claimJourneyComplete(), (e) => e instanceof AuthError && e.code === 'UNKNOWN');
  const ok = repoWith({ auth: authStub, rpc: async () => ({ data: { ok: true, id: 'c', unlocked: [{ id: 'first', on: '2026-09-26' }, { id: 'goal', on: '2026-09-20' }] }, error: null }) });
  assert.deepEqual(await ok.saveCheckin('2026-09-26', { meals: {} }), { unlocked: [{ id: 'first', date: '2026-09-26' }, { id: 'goal', date: '2026-09-20' }] });
});

test('classifyError: rate limits, CAPTCHA and MFA are told apart from generic failures', () => {
  assert.equal(classifyError({ status: 429, message: 'Request rate limit reached' }).code, 'RATE_LIMITED');
  assert.equal(classifyError({ code: 'over_request_rate_limit', message: 'x' }).code, 'RATE_LIMITED');
  assert.equal(classifyError({ code: 'captcha_failed', message: 'captcha protection: request disallowed' }).code, 'CAPTCHA');
  assert.equal(classifyError({ message: 'mfa_required', code: '28000' }).code, 'MFA_REQUIRED');
  assert.equal(classifyError({ message: 'not authenticated', code: '28000' }).code, 'SESSION_EXPIRED', 'unchanged');
});

test('auth requests carry the Turnstile token when configured, and none when not (nothing is faked)', async () => {
  const seen = [];
  const sb = {
    auth: {
      ...authStub,
      signUp: async (a) => { seen.push(['signUp', a.options.captchaToken]); return { data: { user: { identities: [{}] }, session: null }, error: null }; },
      signInWithPassword: async (a) => { seen.push(['signIn', a.options.captchaToken]); return { data: null, error: { message: 'Invalid login credentials' } }; },
    },
  };
  const withKey = repoWith(sb, { getToken: async (a) => `tok-${a}` });
  await assert.rejects(withKey.signUp({ name: 'n', email: 'e@x.com', password: 'longpassword' }), (e) => e.code === 'CONFIRM_EMAIL');
  await assert.rejects(withKey.signIn('e@x.com', 'nope'), (e) => e.code === 'INVALID_CREDENTIALS');
  assert.deepEqual(seen, [['signUp', 'tok-signup'], ['signIn', 'tok-login']]);
  seen.length = 0;
  const noKey = repoWith(sb, createCaptcha({ siteKey: undefined }));
  await assert.rejects(noKey.signIn('e@x.com', 'nope'), (e) => e.code === 'INVALID_CREDENTIALS');
  assert.deepEqual(seen, [['signIn', undefined]]);
});

test('a CAPTCHA that cannot complete blocks the auth request (AuthError CAPTCHA), it is never skipped', async () => {
  let called = false;
  const sb = { auth: { ...authStub, signInWithPassword: async () => { called = true; return { data: null, error: null }; } } };
  const r = repoWith(sb, { getToken: async () => { throw new AuthError('CAPTCHA'); } });
  await assert.rejects(r.signIn('a@x.com', 'p'), (e) => e.code === 'CAPTCHA');
  assert.equal(called, false);
});

test('MFA: a password-only session of a 2FA user is not a login (signIn asks for the code; reload drops the session)', async () => {
  const mfa = (cur, next) => ({ getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: cur, nextLevel: next }, error: null }) });
  let signedOutScope = null;
  const base = {
    ...authStub,
    signInWithPassword: async () => ({ data: { user: { id: 'u1' } }, error: null }),
    signOut: async ({ scope }) => { signedOutScope = scope; return { error: null }; },
  };
  const needs = repoWith({ auth: { ...base, mfa: mfa('aal1', 'aal2') } });
  await assert.rejects(needs.signIn('a@x.com', 'p'), (e) => e.code === 'MFA_REQUIRED');
  assert.equal(await needs.getSession(), null, 'the aal1 session is not restored on reload');
  assert.equal(signedOutScope, 'local', 'and only THIS device is signed out (other devices are untouched)');
  // no MFA / already aal2: normal flow reaches the data loader (which needs tables, so we stop at that point)
  const loaded = [];
  const from = (t) => { loaded.push(t); throw new Error('reached loader'); };
  for (const [c, n] of [['aal1', 'aal1'], ['aal2', 'aal2']]) {
    loaded.length = 0;
    const r = repoWith({ auth: { ...base, mfa: mfa(c, n) }, from });
    await assert.rejects(r.signIn('a@x.com', 'p'), /reached loader|UNKNOWN/);
    assert.ok(loaded.length > 0, `${c}->${n} proceeds to load the user`);
  }
});

test('MFA: a wrong code is MFA_INVALID; a correct code (challengeAndVerify) is required to enroll and to disable', async () => {
  const log = [];
  const auth = {
    ...authStub,
    mfa: {
      listFactors: async () => ({ data: { all: [{ id: 'old', factor_type: 'totp', status: 'unverified' }], totp: [{ id: 'f1', friendly_name: 'Phone', created_at: '2026-09-26T00:00:00Z' }] }, error: null }),
      unenroll: async (a) => { log.push('unenroll:' + a.factorId); return { error: null }; },
      enroll: async () => ({ data: { id: 'f2', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'SECRET', uri: 'otpauth://x' } }, error: null }),
      challengeAndVerify: async ({ factorId, code }) => (code === '123456' ? (log.push('verified:' + factorId), { data: {}, error: null }) : { data: null, error: { status: 400, message: 'Invalid TOTP code entered' } }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
    },
  };
  const r = repoWith({ auth });
  const e = await r.mfaEnroll();
  assert.deepEqual(e, { factorId: 'f2', qrCode: 'data:image/svg+xml;utf8,<svg/>', secret: 'SECRET', uri: 'otpauth://x' });
  assert.ok(log.includes('unenroll:old'), 'an abandoned earlier attempt is cleaned up');
  await assert.rejects(r.mfaConfirm('f2', '000000'), (x) => x.code === 'MFA_INVALID');
  await r.mfaConfirm('f2', '123 456');
  await assert.rejects(r.mfaDisable('f1', '000000'), (x) => x.code === 'MFA_INVALID');
  assert.ok(!log.includes('unenroll:f1'), 'nothing is removed without a valid code');
  await r.mfaDisable('f1', '123456');
  assert.ok(log.includes('unenroll:f1'));
  assert.deepEqual(await r.mfaStatus(), { enabled: true, aal: 'aal2', factors: [{ id: 'f1', name: 'Phone', createdAt: '2026-09-26T00:00:00Z' }] });
});

test('sign-out is explicit about scope (global, as Supabase defaults); a password change also ends every OTHER session', async () => {
  const scopes = [];
  const auth = {
    ...authStub,
    signOut: async (o) => { scopes.push(o && o.scope); return { error: null }; },
    updateUser: async () => ({ data: {}, error: null }),
  };
  const r = repoWith({ auth });
  await r.signOut();
  assert.deepEqual(scopes, ['global']);
  const src = read('src/data/supabaseRepository.js');
  assert.match(src, /updateUser\(\{ password: newPassword \}\)[\s\S]*signOut\(\{ scope: 'others' \}\)/, 'changePassword revokes other sessions after the update');
});

// ---------------------------------------------------------------- static guards
test('session handling: PKCE flow, Supabase-managed persistence, no hand-rolled token storage, no auth logging', () => {
  const repo = read('src/data/supabaseRepository.js');
  assert.match(repo, /flowType:\s*PKCE/);
  assert.match(repo, /persistSession:\s*true,\s*autoRefreshToken:\s*true/);
  for (const f of walk('src/').filter((x) => x.endsWith('.js'))) {
    const t = read(f);
    for (const m of t.matchAll(/(?:local|session)Storage\.(?:get|set|remove)Item\(\s*['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^kc_theme$/, `${f}: only the theme preference may use web storage (found "${m[1]}")`);
    }
    assert.doesNotMatch(t, /console\.(log|debug|info)\(/, `${f}: no console.log of anything`);
    assert.doesNotMatch(t, /(access|refresh)_token|getSession\(\)\)\.data\.session\.access/i, `${f}: never touches raw tokens`);
  }
});

test('production has no mock/demo authentication path', () => {
  const src = walk('src/').filter((f) => f.endsWith('.js')).map((f) => read(f)).join('\n');
  assert.doesNotMatch(src, /mockAuth|fakeAuth|demo(User|Login|Mode)|try-demo|seed_demo|localStorage\.setItem\(['"]kc_(user|session|auth)/i);
  assert.match(read('src/data/repository.js'), /Missing VITE_SUPABASE_URL/);
});

test('.env.example: only browser-safe VITE_ variables, documented, and never a service-role / secret value', () => {
  const t = read('.env.example');
  const names = [...t.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['VITE_DATA_BACKEND', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_TURNSTILE_SITE_KEY']);
  for (const line of t.split('\n').filter((l) => /^[A-Z]/.test(l))) assert.match(line, /=\s*(supabase)?$/, `no value is committed: ${line}`);
  assert.doesNotMatch(t, /VITE_[A-Z_]*(SECRET|SERVICE|PASSWORD|PRIVATE)/);
});

test('git safety: env files are ignored and no real key/secret is present in tracked-looking files', () => {
  const ignore = read('.gitignore');
  for (const p of ['.env', '.env.local']) assert.ok(ignore.split('\n').includes(p), `${p} is gitignored`);
  const jwt = /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/;
  const files = [...walk('src/'), ...walk('tests/'), ...walk('supabase/migrations/'), ...(existsSync(new URL('docs/', ROOT)) ? walk('docs/') : []), 'README.md', 'index.html', 'vite.config.js', '.env.example', 'package.json']
    .filter((f) => !/\.(png|jpg|ico|webp)$/.test(f) && !f.includes('screenshots'));
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, jwt, `${f}: looks like a JWT / API key`);
    assert.doesNotMatch(t, /sb_secret_[A-Za-z0-9]/, `${f}: Supabase secret key`);
    assert.doesNotMatch(t, /0x4[A-Za-z0-9_-]{20,}(?<!site-key)\b.*secret/i, `${f}: Turnstile secret`);
  }
});
