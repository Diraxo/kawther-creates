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
//   saveCheckin(date, checkin)
//   unlockAchievement(id, date)
// A "user" is { name, email, onboarded, journey, checkins, unlocked, unlockedDates }.
import { SupabaseRepository } from './supabaseRepository.js';

let repo = null;

export async function initRepository() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  repo = new SupabaseRepository({ url, anonKey });
  return repo;
}

export function getRepo() {
  if (!repo) throw new Error('Repository not initialised');
  return repo;
}
