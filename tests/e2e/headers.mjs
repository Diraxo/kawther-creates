// Production build served WITH the exact headers from vercel.json (a tiny static server applies them), driven in a real
// browser: proves the CSP does not break the app (assets, fonts, Supabase, Turnstile, theme script) and that every header
// really arrives. Uses Cloudflare's public always-pass TEST site key, never a real one.
//   node tests/e2e/headers.mjs          (needs .env with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY and network access)
import '../live/env.mjs';
import { URL_, KEY } from '../live/env.mjs';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_SITE_KEY = '1x00000000000000000000AA'; // Cloudflare's documented "always passes" test key (public)
const out = mkdtempSync(join(tmpdir(), 'kc-headers-'));
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', out, '--emptyOutDir'], {
  env: { ...process.env, VITE_SUPABASE_URL: URL_, VITE_SUPABASE_ANON_KEY: KEY, VITE_TURNSTILE_SITE_KEY: TEST_SITE_KEY }, stdio: 'ignore',
});

const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
const rules = config.headers.map((h) => ({ re: new RegExp('^' + h.source.replace('(.*)', '.*') + '$'), headers: h.headers }));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = join(out, p);
  if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const h = { 'content-type': TYPES[extname(file)] || 'application/octet-stream' };
  for (const r of rules) if (r.re.test(p)) for (const x of r.headers) h[x.key] = x.value;
  res.writeHead(200, h);
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(5188, r));
const BASE = 'http://localhost:5188';

let passed = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { passed++; console.log('  ✓', n); } else { failures.push(n); console.log('  ✗', n, d); } };

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const problems = [];
const violations = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET|net::ERR|Failed to load resource: the server responded with a status of (400|401|422|429)/.test(m.text())) problems.push('console: ' + m.text()); });
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`));
});

console.log('\nHeaders on the document and on assets');
const res = await page.goto(BASE);
const h = res.headers();
check('Strict-Transport-Security', /max-age=\d{8,}/.test(h['strict-transport-security'] || ''));
check('X-Content-Type-Options: nosniff', h['x-content-type-options'] === 'nosniff');
check('X-Frame-Options: DENY', h['x-frame-options'] === 'DENY');
check('Referrer-Policy', !!h['referrer-policy']);
check('Permissions-Policy', /camera=\(\)/.test(h['permissions-policy'] || ''));
check('Content-Security-Policy', /default-src 'self'/.test(h['content-security-policy'] || ''));

console.log('\nThe app runs under the CSP');
await page.waitForSelector('#s-landing.active', { timeout: 15000 });
check('landing screen renders (bundle JS + CSS load under CSP)', true);
check('theme script (external) applied data-theme before paint', ['dark', 'light'].includes(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))));
check('logo image loads (img-src)', await page.evaluate(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0 || !i.offsetParent)));
check('Google Fonts stylesheet allowed (style-src) or offline', await page.evaluate(() => [...document.styleSheets].length >= 2));

console.log('\nSupabase Auth + Turnstile work under the CSP (real network)');
await page.click('#s-landing [data-target="s-login"]');
await page.fill('#li-email', `csp.probe.${Date.now()}@example.com`);
await page.fill('#li-pass', 'not-a-real-password-1');
await page.click('#s-login [data-action="login"]');
await page.waitForFunction(() => getComputedStyle(document.getElementById('e-login')).display === 'block', null, { timeout: 45000 });
const msg = await page.locator('#e-login').innerText();
check('login attempt reached Supabase and got a clean answer ("incorrect", not a network/CSP failure)', /incorrect/i.test(msg), msg);
const turnstileLoaded = await page.evaluate(() => !!window.turnstile);
check('Turnstile script loaded from challenges.cloudflare.com (script-src)', turnstileLoaded);
check('the Turnstile widget host was cleaned up after the token was used', (await page.locator('[data-kc-captcha]').count()) === 0);

console.log('\nNo CSP violations at all');
const csp = await page.evaluate(() => window.__csp);
check('no securitypolicyviolation events', csp.length === 0, csp.join(' | '));
check('no page or console errors', problems.length === 0, problems.join(' | '));

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
