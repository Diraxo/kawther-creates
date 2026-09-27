// vercel.json security headers: present, and the CSP matches what the app actually loads (checked against index.html and src/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const config = JSON.parse(read('vercel.json'));
const all = config.headers.find((h) => h.source === '/(.*)');
const header = (name) => (all.headers.find((h) => h.key.toLowerCase() === name.toLowerCase()) || {}).value;
const csp = Object.fromEntries((header('Content-Security-Policy') || '').split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test('vercel.json sets every required security header on all routes', () => {
  assert.match(header('Strict-Transport-Security'), /max-age=\d{8,}/);
  assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.equal(header('X-Frame-Options'), 'DENY');
  assert.match(header('Referrer-Policy'), /strict-origin-when-cross-origin|no-referrer|same-origin/);
  assert.match(header('Permissions-Policy'), /camera=\(\)/);
  assert.match(header('Permissions-Policy'), /microphone=\(\)/);
  assert.match(header('Permissions-Policy'), /geolocation=\(\)/);
  assert.ok(header('Content-Security-Policy'));
});

test('Permissions-Policy does not disable features the app uses (Web Share, clipboard)', () => {
  const p = header('Permissions-Policy');
  assert.doesNotMatch(p, /web-share|clipboard/);
});

test('CSP: no unsafe-eval, no script unsafe-inline, no wildcard sources, plugins and framing off', () => {
  assert.ok(!csp['script-src'].some((s) => /unsafe-|^\*$|^https:$|^data:$/.test(s)), `script-src: ${csp['script-src']}`);
  for (const [k, v] of Object.entries(csp)) assert.ok(!v.includes('*'), `${k} must not allow *`);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'self'"]);
  assert.deepEqual(csp['default-src'], ["'self'"]);
  assert.ok('upgrade-insecure-requests' in csp);
});

test('CSP allows exactly what the app depends on: Supabase, Google Fonts, Turnstile, same-origin assets, share-image blobs', () => {
  assert.ok(csp['connect-src'].includes('https://*.supabase.co'), 'Supabase Auth + REST');
  assert.ok(csp['connect-src'].includes("'self'"));
  assert.ok(csp['style-src'].includes('https://fonts.googleapis.com'), 'Google Fonts stylesheet (index.html)');
  assert.ok(csp['font-src'].includes('https://fonts.gstatic.com'), 'Google Fonts files');
  assert.ok(csp['script-src'].includes('https://challenges.cloudflare.com'), 'Turnstile script');
  assert.ok(csp['frame-src'].includes('https://challenges.cloudflare.com'), 'Turnstile iframe');
  assert.ok(csp['img-src'].includes('data:'), 'MFA QR code is a data: SVG from Supabase');
  assert.ok(csp['img-src'].includes('blob:'), 'share image');
  assert.ok(csp['manifest-src'].includes("'self'"));
  assert.ok(csp['style-src'].includes("'unsafe-inline'"), 'the UI uses style="" attributes (cannot be nonce-d)');
});

test('the app really has no inline <script> (so script-src needs no unsafe-inline) and loads only the origins the CSP allows', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc=/, 'every script is external');
    assert.equal(body.trim(), '', 'no inline script body');
  }
  assert.ok(existsSync(new URL('public/theme-init.js', ROOT)));
  const origins = new Set([...html.matchAll(/(?:href|src)="(https:\/\/[^/"]+)/g)].map((m) => m[1]));
  for (const o of origins) assert.ok(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(o), `unexpected third-party origin ${o}`);
  // no inline event handlers (would need script-src 'unsafe-inline' / 'unsafe-hashes')
  assert.doesNotMatch(html, /\son(click|change|input|submit|load|error|keydown|keyup)=/i);
});

test('no source file loads a third-party origin the CSP would block (fonts/Turnstile/Supabase are the only ones)', () => {
  const walk = (dir) => readdirSync(new URL(dir, ROOT)).flatMap((f) => (statSync(new URL(dir + f, ROOT)).isDirectory() ? walk(dir + f + '/') : [dir + f]));
  for (const f of walk('src/').filter((x) => /\.(js|css)$/.test(x))) {
    for (const m of read(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      assert.ok(/^(challenges\.cloudflare\.com|www\.w3\.org|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(m[1]) || /^localhost/.test(m[1]), `${f}: ${m[0]}`);
    }
  }
});

test('hashed assets are cached immutably; HTML is not', () => {
  const assets = config.headers.find((h) => h.source === '/assets/(.*)');
  assert.match(assets.headers[0].value, /immutable/);
  assert.ok(!config.headers.some((h) => h.source === '/(.*)' && h.headers.some((x) => /cache-control/i.test(x.key))));
});
