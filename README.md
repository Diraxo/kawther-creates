# Kawther | creates

A private wellness journal — journeys of 7-365 days (30/60/90 presets or custom) (mobile-first, black + emerald). Vite + vanilla ES modules.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build -> dist/
npm test             # unit tests (domain logic, mappers, empty-account behaviour)
```

There is **no demo account and no sample data**: every user starts with a completely empty journal, and all data
comes from that user's own Supabase account.

## Structure

```
index.html            all screens + overlays declarative data-action attributes
src/main.js           boot + one delegated click/Enter dispatcher (no inline handlers)
src/state.js          in-memory working state
src/domain/           PURE logic: dates, journey/streak, achievements, metrics, check-in helpers
src/data/             repository interface + the Supabase adapter (below)
src/screens/          one module per screen
src/ui/, src/lib/     router, theme, overlays, chart, toast, motion, icons, formatting
src/styles/           the app CSS, split into contiguous slices (cascade order preserved)
supabase/schema.sql   tables, constraints, RLS, profile trigger
tests/unit, tests/e2e node:test + Playwright
```

## Data layer / Supabase

Screens never touch storage; they call `getRepo()` (`src/data/repository.js`), an async interface:
`getSession, signUp, signIn, signOut, changePassword, createJourney, updateWaterGoal, saveCheckin, unlockAchievement`.

`SupabaseRepository` is the only backend (Supabase Auth + Postgres under RLS). There is no local/offline fallback: if
Supabase is unreachable the app says so and nothing is shown as saved. The only browser storage used is the Supabase
session (managed by supabase-js) and the `kc_theme` appearance preference.

## Supabase setup (real backend)

1. Create a project. **SQL editor → run the whole of `supabase/schema.sql`** (re-runnable; fresh project expected).
2. **Auth → Providers → Email**: for the simplest setup turn **Confirm email OFF** (the signup flow then signs the user in
   immediately). With it ON, signup shows "check your inbox" and the user logs in after confirming — also supported.
3. `cp .env.example .env`, then set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   (**anon** key only; the `service_role` key must never be used in this app). `.env` is git-ignored. Restart `npm run dev`.
   Missing variables are reported on screen at boot ("isn't configured correctly") — nothing fails silently.
4. Upgrading a project that already ran an older `schema.sql`, run the migrations in `supabase/migrations/` in date order.
   **`2026-09-27_exercise_unit.sql` is required for movement durations entered in hours** ("1 hr" stays "1 hr"); without it the
   app still works but a duration is shown back in minutes after a reload. Older still: run `supabase/migrations/2026-09-26_drop_seed_demo.sql`
   (removes the old demo seeder) and delete the old `demo@kawthercreates.com` user in Auth → Users.

### What the schema creates
`profiles` (1:1 with `auth.users`, created by the `on_auth_user_created` trigger), `journeys` (one per user),
`checkins` (unique per user+date), `checkin_meals` (composite FK `(checkin_id,user_id)` → `checkins(id,user_id)`, so a meal
can never be attached to another user's check-in), `user_achievements` (unlock rows only; definitions live in code).
There is **no** password column anywhere — Supabase Auth owns credentials.
RLS is on for all five tables; every policy is `to authenticated` and scoped to `auth.uid()`; table privileges are revoked from
`anon` and re-granted minimally (no client DELETE except a day's meals; profiles' `email`/`id` are not client-editable).
Two `SECURITY INVOKER` RPCs (they run as the caller, so RLS still applies to every statement):
`save_checkin` (upsert day + replace meals, **one transaction**) and `create_journey` (journey + onboarded flag, atomic).

### Product rules (one implementation, used by every screen)
- **Day 1 = the start date.** Goal date = start + (duration − 1) (`goalDate()` in `src/domain/journey.js`); all dates are local calendar days, never UTC.
- **Streak** (`src/domain/streak.js`, derived from real check-in dates, nothing stored): a run of consecutive check-in days. It is *active* if it
  includes today, *pending* if it ends yesterday, and *interrupted* if the last check-in is 2+ days old. An interrupted streak is **not** reset to
  a fake zero: the earned run and the best run are kept ("Streak paused" + "Renew your streak"); the next check-in starts a new run at 1.
- **Progress range vs. journey length are independent.** A window is "the last N days, clipped to the journey start"; stats are computed only from
  check-ins inside it and the UI says how many days really exist ("1 of 7 days recorded"). The chart plots only saved weigh-ins.
- **Movement** is stored as whole minutes plus the unit typed (`exercise_unit`), so it is shown back exactly as entered.
- **Achievements** have documented, real conditions (`src/domain/achievements.js`); locked ones show `Progress: n / target`.
- **Change password** verifies the current password with a real Supabase sign-in (throw-away client) before calling `updateUser`.

### Tests
`npm test` (unit) · `npm run test:db` (schema/RLS/RPC on a real in-process Postgres) · `npm run test:failures` (browser,
faked network: outages, RLS rejections, expired sessions) · `npm run test:live` (real project: repository RLS/persistence,
the full browser account flow, and the splash/responsive/empty-state audit; creates throw-away `kc.test.*` accounts) ·
`npm run test:ux` (real project: the Home/check-in/streak/progress/graph/journey/profile/share/logout/password behaviours and a
11-width responsive audit; unit persistence is reported NOT VERIFIED until the exercise_unit migration is applied).

Known limits: theme stays a per-device localStorage preference; achievements are computed by the client and stored by it, so a
user can grant *themselves* achievements (affects only their own data).
