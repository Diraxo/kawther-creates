// Cloudflare Turnstile for Supabase Auth's CAPTCHA protection.
//
// How it fits together (see docs/SECURITY_DEPLOYMENT_CHECKLIST.md):
//   * The SITE key is public and lives in VITE_TURNSTILE_SITE_KEY. The SECRET key is entered ONLY in the Supabase dashboard
//     (Authentication -> Attack Protection). It never touches this repository or the browser.
//   * When CAPTCHA protection is enabled in Supabase, Auth rejects every sign-up / sign-in / password-recovery request that
//     lacks a valid token, no matter which client sent it. So this file cannot weaken the protection; it only supplies tokens.
//   * Unconfigured (no site key): NO token is produced and NOTHING is faked. If the dashboard requires CAPTCHA, Supabase
//     rejects the request and the user sees a clear error. There is no bypass and no fake "verified" state.
import { AuthError } from '../data/errors.js';

export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TIMEOUT_MS = 45000;

/** Injects Cloudflare's script once and resolves when `window.turnstile` exists. */
function loadTurnstile(doc, win) {
  if (win.turnstile) return Promise.resolve(win.turnstile);
  if (!loadTurnstile.pending) {
    loadTurnstile.pending = new Promise((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = TURNSTILE_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => (win.turnstile ? resolve(win.turnstile) : reject(new Error('turnstile missing')));
      s.onerror = () => { loadTurnstile.pending = null; reject(new Error('turnstile failed to load')); };
      doc.head.appendChild(s);
    });
  }
  return loadTurnstile.pending;
}

/**
 * @param {{ siteKey?: string, doc?: Document, win?: Window, load?: (doc, win) => Promise<any> }} o
 * @returns {{ enabled: boolean, getToken: (action?: string) => Promise<string|undefined> }}
 */
export function createCaptcha({ siteKey, doc = globalThis.document, win = globalThis.window, load = loadTurnstile } = {}) {
  const key = typeof siteKey === 'string' ? siteKey.trim() : '';
  const enabled = key.length > 0;

  /** A one-time token for one auth request (tokens are single use, so every attempt gets a fresh widget). */
  async function getToken(action = 'auth') {
    if (!enabled) return undefined;
    let api;
    try {
      api = await load(doc, win);
    } catch {
      throw new AuthError('CAPTCHA', 'The security check could not load');
    }
    const host = doc.createElement('div');
    host.setAttribute('data-kc-captcha', action);
    // Invisible unless Cloudflare needs the user to interact; then it appears as a small centred card.
    Object.assign(host.style, { position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '3000', display: 'none' });
    doc.body.appendChild(host);
    const cleanup = (id) => { try { api.remove(id); } catch { /* already gone */ } host.remove(); };
    return new Promise((resolve, reject) => {
      let id;
      const timer = setTimeout(() => { cleanup(id); reject(new AuthError('CAPTCHA', 'The security check timed out')); }, TIMEOUT_MS);
      const done = (fn, v) => { clearTimeout(timer); cleanup(id); fn(v); };
      id = api.render(host, {
        sitekey: key,
        action,
        appearance: 'interaction-only',
        'before-interactive-callback': () => { host.style.display = 'block'; },
        'after-interactive-callback': () => { host.style.display = 'none'; },
        callback: (token) => done(resolve, token),
        'error-callback': () => done(reject, new AuthError('CAPTCHA', 'The security check failed')),
        'expired-callback': () => done(reject, new AuthError('CAPTCHA', 'The security check expired')),
      });
    });
  }
  return { enabled, getToken };
}
