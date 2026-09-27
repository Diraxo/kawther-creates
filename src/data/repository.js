// The one data backend: Supabase (Auth + Postgres under RLS). Screens only ever call getRepo().
//
// Repository interface (all async):
//   getSession()                    -> user | null
//   signUp({name,email,password})   -> user      (throws AuthError EXISTS | CONFIRM_EMAIL)
//   signIn(email,password)          -> user      (throws AuthError INVALID_CREDENTIALS)
//   signOut()
//   changePassword(current, next)   verifies `current` with Supabase Auth, then updates the password
//   createJourney(journey)          marks the user onboarded
//   updateWaterGoal(ml)
//   startNextJourney(journey, mode) archives the completed journey and starts the next (mode: continue|new_goal|maintain|journal)
//   setPostGoal(mode, nextGoal)     after the original goal is achieved: 'new_goal' | 'maintain' | 'journal'
//   saveCheckin(date, checkin)      -> { unlocked: [{ id, date }] } what the DATABASE granted (achievements are never client-written)
//   claimJourneyComplete()          -> { unlocked: [{ id, date }] }
//   startNextJourney(journey, mode)
//   verifyMfaLogin(code) / mfaStatus() / mfaEnroll() / mfaConfirm(id, code) / mfaDisable(id, code)   opt-in two-factor (TOTP)
// Writes are RPC-only (rate-limited, validated in the database); a rate-limit hit throws AuthError RATE_LIMITED.
// A "user" is { name, email, onboarded, journey, checkins, unlocked, unlockedDates }.
import { SupabaseRepository } from './supabaseRepository.js';
import { createCaptcha } from '../lib/turnstile.js';

let repo = null;

export async function initRepository() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  // Site key only (public). The Turnstile SECRET is configured in the Supabase dashboard and never lives here.
  const captcha = createCaptcha({ siteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY });
  repo = new SupabaseRepository({ url, anonKey, captcha });
  return repo;
}

export function getRepo() {
  if (!repo) throw new Error('Repository not initialised');
  return repo;
}
