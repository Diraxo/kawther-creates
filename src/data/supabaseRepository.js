// Supabase-backed repository (Auth + Postgres under RLS). Schema: supabase/schema.sql.
// This is the only data backend. Passwords only ever go to Supabase Auth.
// Every failure is thrown as a classified AuthError — nothing is swallowed, so the UI can never
// report "saved" for a write Supabase rejected.
import { createClient } from '@supabase/supabase-js';
import { AuthError, classifyError } from './errors.js';
import {
  checkinToPayload, journeyToRpcArgs, nextJourneyToRpcArgs, rowsToAchievements, rowsToCheckins, splitJourneys,
} from './mappers.js';

const PAGE = 1000; // PostgREST's default max rows per response

/** Throws a classified error for a supabase-js `{ error }` result. */
function fail(error) {
  if (error) throw classifyError(error);
}

// The browser can READ its own rows (RLS) and call trusted RPCs; it has no direct write privilege on any table
// (supabase/schema.sql). Every write below is therefore an RPC, validated and rate-limited in the database.
const PKCE = 'pkce'; // auth codes travel as ?code=... and are exchanged with a verifier held in this browser: no tokens in URLs

export class SupabaseRepository {
  /** @param {{ url: string, anonKey: string, captcha?: { getToken: (action?: string) => Promise<string|undefined> } }} o */
  constructor({ url, anonKey, captcha }) {
    this.url = url;
    this.anonKey = anonKey;
    this.captcha = captcha || { getToken: async () => undefined };
    this.sb = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, flowType: PKCE } });
  }

  /** A Turnstile token for the next auth request, or undefined when CAPTCHA is not configured (nothing is faked). */
  async #captchaToken(action) {
    try {
      return await this.captcha.getToken(action);
    } catch (e) {
      throw classifyError(e);
    }
  }

  /** Calls a trusted RPC. Clean application errors: a rate-limit hit becomes AuthError RATE_LIMITED (with retryAfter). */
  async #rpc(name, args) {
    await this.#userId();
    let res;
    try {
      res = await this.sb.rpc(name, args);
    } catch (e) {
      throw classifyError(e);
    }
    fail(res.error);
    const d = res.data;
    if (d && typeof d === 'object' && d.ok === false) {
      if (d.code === 'rate_limited') throw new AuthError('RATE_LIMITED', 'Too many requests', { retryAfter: d.retry_after });
      throw new AuthError('UNKNOWN', String(d.code || 'rejected'));
    }
    return d;
  }

  /** The signed-in user's id. getSession() refreshes an expired access token or reports no session. */
  async #userId() {
    let res;
    try {
      res = await this.sb.auth.getSession();
    } catch (e) {
      throw classifyError(e);
    }
    fail(res.error);
    if (!res.data.session) throw new AuthError('SESSION_EXPIRED', 'Not signed in');
    return res.data.session.user.id;
  }

  /** Reads every row of a query, paging past PostgREST's 1000-row cap. */
  async #all(table, uid) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb.from(table).select('*').eq('user_id', uid).order('id').range(from, from + PAGE - 1);
      fail(error);
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }

  /** Loads profile + journey + check-ins + meals + achievements into the domain shape. */
  async #load(authUser) {
    const uid = authUser.id;
    let res;
    try {
      res = await Promise.all([
        this.sb.from('profiles').select('*').eq('id', uid).maybeSingle(),
        this.sb.from('journeys').select('*').eq('user_id', uid).order('start_date'),
        this.#all('checkins', uid),
        this.#all('checkin_meals', uid),
        this.sb.from('user_achievements').select('*').eq('user_id', uid),
      ]);
    } catch (e) {
      throw classifyError(e);
    }
    const [profile, journey, checkins, meals, ach] = res;
    [profile, journey, ach].forEach((r) => fail(r.error));
    const { journey: active, past } = splitJourneys(journey.data || []);
    // A signed-in user with no profile row means the signup trigger did not run. Never guess: fail loudly.
    if (!profile.data) throw new AuthError('UNKNOWN', 'Profile row missing (is the signup trigger installed?)');
    return {
      name: profile.data.full_name,
      email: authUser.email,
      onboarded: !!(profile.data.onboarded && active),
      journey: active,
      pastJourneys: past, // completed journeys: immutable history (Journey 1..N-1)
      checkins: rowsToCheckins(checkins, meals),
      ...rowsToAchievements(ach.data, active),
    };
  }

  /** Restores a session after reload. Returns null only when there genuinely is no (valid) session. */
  async getSession() {
    let res;
    try {
      res = await this.sb.auth.getSession();
    } catch (e) {
      throw classifyError(e);
    }
    if (res.error) {
      const err = classifyError(res.error);
      if (err.code === 'SESSION_EXPIRED') return null; // revoked/expired refresh token -> logged out, say so via login
      throw err;
    }
    if (!res.data.session) return null;
    if (await this.#needsSecondFactor()) {
      // A password-only (aal1) session of a user who turned on 2FA is not a login: the database refuses it anyway.
      await this.sb.auth.signOut({ scope: 'local' }).catch(() => {});
      return null;
    }
    return this.#load(res.data.session.user);
  }

  /**
   * True when the user has a verified second factor but this session has only proven the password. Purely a UX routing
   * decision: the DATABASE enforces it (restrictive RLS + aal checks in every RPC), so an undecidable answer is "no".
   */
  async #needsSecondFactor() {
    try {
      const { data, error } = await this.sb.auth.mfa.getAuthenticatorAssuranceLevel();
      return !error && data.currentLevel === 'aal1' && data.nextLevel === 'aal2';
    } catch {
      return false;
    }
  }

  async signUp({ name, email, password }) {
    const captchaToken = await this.#captchaToken('signup');
    let res;
    try {
      res = await this.sb.auth.signUp({ email, password, options: { data: { full_name: name }, captchaToken } });
    } catch (e) {
      throw classifyError(e);
    }
    const { data, error } = res;
    if (error) {
      if (/already/i.test(error.message)) throw new AuthError('EXISTS');
      throw classifyError(error);
    }
    // With email confirmation on, an existing address returns a user with no identities.
    if (data.user && data.user.identities && data.user.identities.length === 0) throw new AuthError('EXISTS');
    if (!data.session) throw new AuthError('CONFIRM_EMAIL');
    return this.#load(data.session.user);
  }

  async signIn(email, password) {
    const captchaToken = await this.#captchaToken('login');
    let res;
    try {
      res = await this.sb.auth.signInWithPassword({ email, password, options: { captchaToken } });
    } catch (e) {
      throw classifyError(e);
    }
    const { data, error } = res;
    if (error) {
      if (/invalid login|invalid credentials/i.test(error.message)) throw new AuthError('INVALID_CREDENTIALS');
      if (/email not confirmed/i.test(error.message)) throw new AuthError('CONFIRM_EMAIL');
      throw classifyError(error);
    }
    // Two-factor: the password alone is not enough for a user who enabled it. The UI asks for the code, then calls verifyMfaLogin.
    if (await this.#needsSecondFactor()) throw new AuthError('MFA_REQUIRED');
    return this.#load(data.user);
  }

  /** Completes a login that threw MFA_REQUIRED with the 6-digit code from the authenticator app. */
  async verifyMfaLogin(code) {
    await this.#verifyTotp(code);
    let res;
    try {
      res = await this.sb.auth.getUser();
    } catch (e) {
      throw classifyError(e);
    }
    fail(res.error);
    return this.#load(res.data.user);
  }

  /** Drops a half-finished (password-only) login on THIS device only; other devices' sessions are untouched. */
  async abandonPendingLogin() {
    await this.sb.auth.signOut({ scope: 'local' }).catch(() => {});
  }

  /** Signs out of EVERY device (Supabase's default scope, made explicit). Sessions elsewhere die when their token expires. */
  async signOut() {
    const { error } = await this.sb.auth.signOut({ scope: 'global' });
    // A dead session/network must not trap the user in the app: local sign-out already happened.
    if (error && classifyError(error).code === 'UNKNOWN') fail(error);
  }

  /**
   * Changes the signed-in user's password with Supabase Auth.
   * `updateUser({ password })` does not itself ask for the old password, so the CURRENT password is verified first
   * with a real sign-in on a throw-away client (no stored session, so it can't disturb the app's own session).
   * Throws AuthError INVALID_CREDENTIALS (wrong current password), WEAK_PASSWORD, SAME_PASSWORD, or a classified error.
   * Passwords are never stored anywhere by the app.
   */
  async changePassword(currentPassword, newPassword) {
    let res;
    try {
      res = await this.sb.auth.getSession();
    } catch (e) {
      throw classifyError(e);
    }
    fail(res.error);
    const user = res.data.session && res.data.session.user;
    if (!user || !user.email) throw new AuthError('SESSION_EXPIRED', 'Not signed in');

    const verifier = createClient(this.url, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'kc-password-verify' },
    });
    const captchaToken = await this.#captchaToken('verify-password');
    let check;
    try {
      check = await verifier.auth.signInWithPassword({ email: user.email, password: currentPassword, options: { captchaToken } });
    } catch (e) {
      throw classifyError(e);
    }
    if (check.error) {
      if (/invalid login|invalid credentials/i.test(check.error.message)) throw new AuthError('INVALID_CREDENTIALS');
      throw classifyError(check.error);
    }
    await verifier.auth.signOut({ scope: 'local' }).catch(() => {});

    let upd;
    try {
      upd = await this.sb.auth.updateUser({ password: newPassword });
    } catch (e) {
      throw classifyError(e);
    }
    if (upd.error) {
      if (upd.error.code === 'same_password' || /different from the old password/i.test(upd.error.message)) throw new AuthError('SAME_PASSWORD');
      if (upd.error.code === 'weak_password' || /password.*(weak|at least|characters)/i.test(upd.error.message)) throw new AuthError('WEAK_PASSWORD', upd.error.message);
      throw classifyError(upd.error);
    }
    // A changed password must end every OTHER session (a stolen session must not survive it); this device stays signed in.
    await this.sb.auth.signOut({ scope: 'others' }).catch(() => {});
  }

  // ---------- two-factor authentication (Supabase TOTP; opt-in, e.g. for the creator account) ----------
  async #factors() {
    let res;
    try {
      res = await this.sb.auth.mfa.listFactors();
    } catch (e) {
      throw classifyError(e);
    }
    fail(res.error);
    return res.data;
  }

  async #verifyTotp(code, factorId) {
    const id = factorId || ((await this.#factors()).totp[0] || {}).id;
    if (!id) throw new AuthError('MFA_INVALID', 'No authenticator is set up');
    let res;
    try {
      res = await this.sb.auth.mfa.challengeAndVerify({ factorId: id, code: String(code).replace(/\s+/g, '') });
    } catch (e) {
      throw classifyError(e);
    }
    if (res.error) {
      if (res.error.status === 400 || /invalid|incorrect|expired/i.test(res.error.message)) throw new AuthError('MFA_INVALID', res.error.message);
      throw classifyError(res.error);
    }
  }

  /** { enabled, aal, factors:[{ id, name, createdAt }] } for the verified authenticators and this session's assurance level. */
  async mfaStatus() {
    const f = await this.#factors();
    const aal = await this.sb.auth.mfa.getAuthenticatorAssuranceLevel();
    return {
      enabled: f.totp.length > 0,
      aal: aal.data ? aal.data.currentLevel : null,
      factors: f.totp.map((x) => ({ id: x.id, name: x.friendly_name || 'Authenticator app', createdAt: x.created_at })),
    };
  }

  /** Starts enrolment: returns the QR code (SVG data URI), the manual setup key and the pending factor id. Nothing is enforced until confirmed. */
  async mfaEnroll() {
    const f = await this.#factors();
    for (const stale of f.all.filter((x) => x.factor_type === 'totp' && x.status !== 'verified')) {
      await this.sb.auth.mfa.unenroll({ factorId: stale.id }).catch(() => {}); // abandoned earlier attempts
    }
    let res;
    try {
      res = await this.sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}` });
    } catch (e) {
      throw classifyError(e);
    }
    fail(res.error);
    const t = res.data.totp;
    return { factorId: res.data.id, qrCode: t.qr_code, secret: t.secret, uri: t.uri };
  }

  /** Confirms enrolment with a code from the app. From then on this account needs the code at every login. */
  async mfaConfirm(factorId, code) {
    await this.#verifyTotp(code, factorId);
  }

  /** Turns 2FA off for one authenticator; needs a fresh code (and an aal2 session, which the database/Auth enforce). */
  async mfaDisable(factorId, code) {
    await this.#verifyTotp(code, factorId);
    let res;
    try {
      res = await this.sb.auth.mfa.unenroll({ factorId });
    } catch (e) {
      throw classifyError(e);
    }
    fail(res.error);
  }

  async createJourney(journey) {
    await this.#rpc('create_journey', journeyToRpcArgs(journey));
  }

  async updateWaterGoal(ml) {
    await this.#rpc('update_water_goal', { p_ml: ml });
  }

  /**
   * Journey Complete -> "What's next": archives the finished journey and starts the next one in one transaction.
   * `mode`: 'continue' | 'new_goal' | 'maintain' | 'journal'.
   */
  async startNextJourney(journey, mode) {
    await this.#rpc('start_next_journey', nextJourneyToRpcArgs(journey, mode));
  }

  /** Records what she chose after achieving her goal: 'new_goal' (with a weight) | 'maintain' | 'journal'. */
  async setPostGoal(mode, nextGoal = null) {
    await this.#rpc('set_post_goal', { p_mode: mode, p_next: mode === 'new_goal' ? nextGoal : null });
  }

  /**
   * Atomic: one RPC upserts the day's check-in and replaces its meals in a single transaction, then the DATABASE derives
   * any achievements the data now earns. Returns { unlocked: [{ id, date }] } - what the server actually granted.
   */
  async saveCheckin(date, checkin) {
    const d = await this.#rpc('save_checkin', { p_date: date, p_checkin: checkinToPayload(checkin) });
    return { unlocked: (d && Array.isArray(d.unlocked) ? d.unlocked : []).map((u) => ({ id: u.id, date: u.on })) };
  }

  /** 'Journey Complete' is granted by the server once the active journey's last day has arrived. -> { unlocked: [{ id, date }] } */
  async claimJourneyComplete() {
    const d = await this.#rpc('claim_journey_complete', {});
    return { unlocked: (d && Array.isArray(d.unlocked) ? d.unlocked : []).map((u) => ({ id: u.id, date: u.on })) };
  }
}
