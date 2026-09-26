// Supabase-backed repository (Auth + Postgres under RLS). Schema: supabase/schema.sql.
// This is the only data backend. Passwords only ever go to Supabase Auth.
// Every failure is thrown as a classified AuthError — nothing is swallowed, so the UI can never
// report "saved" for a write Supabase rejected.
import { createClient } from '@supabase/supabase-js';
import { AuthError, classifyError } from './errors.js';
import {
  checkinToPayload, journeyToRpcArgs, rowToJourney, rowsToAchievements, rowsToCheckins,
} from './mappers.js';

const PAGE = 1000; // PostgREST's default max rows per response

/** Throws a classified error for a supabase-js `{ error }` result. */
function fail(error) {
  if (error) throw classifyError(error);
}

export class SupabaseRepository {
  constructor({ url, anonKey }) {
    this.url = url;
    this.anonKey = anonKey;
    this.sb = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
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
        this.sb.from('journeys').select('*').eq('user_id', uid).maybeSingle(),
        this.#all('checkins', uid),
        this.#all('checkin_meals', uid),
        this.sb.from('user_achievements').select('*').eq('user_id', uid),
      ]);
    } catch (e) {
      throw classifyError(e);
    }
    const [profile, journey, checkins, meals, ach] = res;
    [profile, journey, ach].forEach((r) => fail(r.error));
    // A signed-in user with no profile row means the signup trigger did not run. Never guess: fail loudly.
    if (!profile.data) throw new AuthError('UNKNOWN', 'Profile row missing (is the signup trigger installed?)');
    return {
      name: profile.data.full_name,
      email: authUser.email,
      onboarded: !!(profile.data.onboarded && journey.data),
      journey: journey.data ? rowToJourney(journey.data) : null,
      checkins: rowsToCheckins(checkins, meals),
      ...rowsToAchievements(ach.data),
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
    return res.data.session ? this.#load(res.data.session.user) : null;
  }

  async signUp({ name, email, password }) {
    let res;
    try {
      res = await this.sb.auth.signUp({ email, password, options: { data: { full_name: name } } });
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
    let res;
    try {
      res = await this.sb.auth.signInWithPassword({ email, password });
    } catch (e) {
      throw classifyError(e);
    }
    const { data, error } = res;
    if (error) {
      if (/invalid login|invalid credentials/i.test(error.message)) throw new AuthError('INVALID_CREDENTIALS');
      if (/email not confirmed/i.test(error.message)) throw new AuthError('CONFIRM_EMAIL');
      throw classifyError(error);
    }
    return this.#load(data.user);
  }

  async signOut() {
    const { error } = await this.sb.auth.signOut();
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
    let check;
    try {
      check = await verifier.auth.signInWithPassword({ email: user.email, password: currentPassword });
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
  }

  async createJourney(journey) {
    await this.#userId();
    fail((await this.sb.rpc('create_journey', journeyToRpcArgs(journey))).error);
  }

  async updateWaterGoal(ml) {
    const uid = await this.#userId();
    const { data, error } = await this.sb.from('journeys').update({ water_goal_ml: ml }).eq('user_id', uid).select('id');
    fail(error);
    if (!data.length) throw new AuthError('FORBIDDEN', 'No journey to update');
  }

  /** Atomic: one RPC upserts the day's check-in and replaces its meals in a single transaction. */
  async saveCheckin(date, checkin) {
    await this.#userId();
    fail((await this.sb.rpc('save_checkin', { p_date: date, p_checkin: checkinToPayload(checkin) })).error);
  }

  async unlockAchievement(id, date) {
    const uid = await this.#userId();
    fail(
      (await this.sb.from('user_achievements').upsert({ user_id: uid, achievement_id: id, unlocked_on: date }, { onConflict: 'user_id,achievement_id' })).error,
    );
  }
}
