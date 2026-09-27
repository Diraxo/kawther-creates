# Security model — Kawther | creates

> **Verification status.** Everything below is verified against local Postgres (PGlite) only. The migrations have **NOT been applied to or verified against the
> hosted production project `qgrbygvtqgeokvyvizwf`**, so no claim of production security is made here. See the deployment checklist before applying anything.

**The frontend is never a security boundary.** Anyone can open DevTools and call Supabase with their own valid session. The database must refuse
everything the app would not do.

```
Browser ──read (RLS)──────────────────────────► own rows only
   └──────RPC (validated, rate-limited)───────► SECURITY DEFINER function ──► tables
   ✗ direct INSERT / UPDATE / DELETE on any application table: no privilege
```

## What a malicious signed-in user cannot do (all tested in real Postgres and, after migration, against the live project)
- Insert/update/delete `user_achievements` (`goal`, `d14`, `consistent`, `journey`…), change an achievement id or unlock date, or grant one to another user.
  Achievements are **derived by the database** from the user's saved rows (`private.earned_achievements`) and granted only inside `save_checkin` /
  `claim_journey_complete`. The rules are the ones in `src/domain/achievements.js`; a test runs both on 250 random histories and requires identical results.
- Write `journeys`, `checkins`, `checkin_meals`, `profiles.onboarded/email`, or `security_events` directly. Own row or someone else's: refused.
- Skip validation: every RPC re-validates type, range, length, date window, enum values and volume, then re-checks ownership with `auth.uid()`.
- Supply a user id: no RPC has such a parameter; ownership comes only from the JWT.
- Flood writes: sliding-window per-user limits inside the RPCs; a hit returns `{ok:false, code:'rate_limited', retry_after}` (no database exception text).
- Read anyone else's data, or read anything at all while unauthenticated.
- (MFA users) use a password-only session: restrictive RLS + `aal2` checks in every RPC.
- Rewrite an active journey into an instant "completed" one (see *Journey integrity* below).

## Migration architecture
| File | Role | Failure behaviour |
|---|---|---|
| `supabase/migrations/2026-09-30_security_hardening.sql` | **Core**: RLS, grants/revokes, security functions, achievement protection, rate limits, MFA/AAL2, journey integrity, one-time legacy achievement cleanup | One transaction (`begin; set local lock_timeout = '5s'; … commit;`). Any error, lock wait > 5 s, missing prerequisite or failed smoke test rolls **everything** back |
| `supabase/migrations/2026-09-30b_auth_audit_triggers.sql` | **Optional**: audit triggers on `auth.users`, `auth.sessions`, `auth.mfa_factors` | Own transaction; a trigger that cannot be installed raises a WARNING naming the table, the others are still tried. Nothing in the core depends on it |
| `supabase/schema.sql` | Fresh project: contains both sections, byte-identical to the two migration files (a test enforces it) | n/a |

- **Prerequisites** are checked first: `journeys.completed_on / post_goal_mode / next_goal_weight`, `checkins.exercise_unit`, the one-active-journey index, the
  `journey` achievement check and the core tables. A missing one raises a named error before anything changes.
- **Policies** on the six protected tables are dropped *by catalog (`pg_policies`), whatever their name*, then only the intended ones are recreated, so a stray
  dashboard-created or experimental policy cannot survive. Other tables' policies are untouched.
- **`private.aal_ok()` smoke test:** the migration executes it (it reads `auth.mfa_factors` as the migration role) and checks that `authenticated` can call it and
  `anon` cannot reach `private`. If it cannot run, the migration aborts with an explicit error — the function is not weakened and the error is not swallowed.
- **Re-running:** not a supported workflow. The structural part is idempotent; the legacy cleanup is guarded by `private.schema_markers`
  (`legacy_achievement_cleanup`) and by the existence of `private.achievements_quarantine` (an earlier revision already ran it), so it never quarantines twice.
  A fresh `schema.sql` database is stamped as already clean.
- The pre-existing signup trigger `on_auth_user_created` (profile creation) stays in the core: it is required for sign-up and was already part of the schema.

## Achievement immutability and history
- The browser cannot insert, update or delete `user_achievements`. A forged row is refused (`permission denied`; there is also no permissive policy).
- New achievements are granted only by the database from real rows. **Once granted they are sticky**: `grant_achievements` never deletes, and only replaces a
  `goal`/`journey` row from a *finished* journey when the new journey genuinely re-earns it. A later weight change, a dropped streak, a raised water goal or a
  new journey never revokes an achievement.
- The **one-time legacy cleanup** treats existing rows (written by the old, unprotected client) as untrusted, but judges them by **monotonic historical evidence**:
  "did the user's data up to `unlocked_on + 1 day` ever reach the bar, in some journey (finished ones included)?" — never "does today's active journey still show it?".

  | Achievement | Evidence that keeps the row |
  |---|---|
  | first | a check-in on/before the cutoff |
  | d3 / d7 / d14 | a run of 3 / 7 / 14 consecutive check-in days on/before the cutoff |
  | hydrated | ≥ 7 check-ins with water ≥ 500 ml (the lowest goal that can exist: the goal at unlock time was not recorded, and it may have been raised since) |
  | active | ≥ 4 workouts inside a 7-day window on/before the cutoff |
  | consistent | in some journey, on some check-in day ≤ cutoff: ≥ 7 check-ins and ≥ 80 % of the journey's days so far |
  | goal | a check-in inside some journey (its own dates) reached that journey's goal weight |
  | journey | the last day of some journey (finished or active) had arrived by the cutoff |

  Rows without such evidence are **moved** to `private.achievements_quarantine` (restorable, checklist §5), never deleted. Limits: if the very check-in that proved
  an old achievement was later overwritten, the row is judged on what remains (hence quarantine, not deletion); and a *pre-hardening* forger who also rewrote a
  journey's dates so that it "ended" cannot be told apart from a real finished journey for the `journey` achievement.

## Journey integrity (create_journey / start_next_journey)
Exact rule, enforced in SQL:
1. **Not already over.** A journey whose last day (`start + duration − 1`) is before today (server date) cannot be created or edited into existence
   (`create_journey`, and the new journey of `start_next_journey`). A journey ending today, or later, is fine, including a back-dated start.
2. **History freezes.** Once the active journey has a check-in on/after its start date: the start date may only stay or move **later, up to the first check-in**
   (never earlier, never past the first check-in, so no check-in is orphaned); the starting weight cannot change; the goal weight may change only to a weight no
   existing check-in has already reached (else "Goal Achieved" could be handed out for free). Duration and water goal stay editable (within rule 1).
3. **Before any check-in** the journey is freely editable (onboarding), within rule 1.

Starting the next journey after a finished one is unchanged, apart from rule 1. The app only calls `create_journey` during onboarding (start = today), so normal use is unaffected.
Residual: a brand-new user can still back-date a journey that ends **today** and claim it the same day (calendar-based completion is product behaviour).

## MFA / AAL2
A user with a **verified** TOTP factor must be on an `aal2` session: restrictive RLS policies on all six tables and an `aal_ok()` check at the top of every RPC
(`mfa_required`, which the app maps to "sign in again"). Users without MFA are unaffected. `aal_ok()` fails closed (no JWT claim ⇒ aal1).

## Volume and validation limits (enforced in SQL, not JS)
| Item | Limit |
|---|---|
| Check-ins | 1 per user per date (unique); date ≤ tomorrow (time-zone slack), ≥ 400 days back; needs an active journey |
| Weight | 30–300 kg · water 0–20 000 ml whole · notes ≤ 4 000 chars · mood ∈ 5 values |
| Movement | 1 workout per check-in (type ≤ 60, whole minutes 0–1 440, both or neither, unit minutes/hours) |
| Meals | ≤ 30 per day · category ∈ 4 · name 1–200 · notes ≤ 1 000 · time `HH:MM` · position 0–99 |
| Payload | JSON object ≤ 100 kB |
| Journey | duration 7–365 · weights 30–300 · water goal 500–6 000 · start ≤ 30 days ahead, ≤ 10 years back **and its last day not already past** · **exactly one active journey per user** (partial unique index); finished journeys are immutable history; history freezes once check-ins exist (see *Journey integrity*) |
| Rate limits (per user, sliding) | `save_checkin` 30 / 5 min & 400 / day · `create_journey` 10 / h & 30 / day · `start_next_journey` 5 / h & 10 / day · `update_water_goal` + `set_post_goal` 20 / h & 100 / day (shared) · `claim_journey_complete` 20 / h & 100 / day |

Blocked calls are not recorded, so a limited user is never locked out longer than the window; normal use (a handful of saves a day) is nowhere near the limits.

## Function review (Phase 14)
All functions pin `search_path = ''` (every object is schema-qualified). `PUBLIC` and `anon` have `EXECUTE` on **none**. Enforced by a test that reads `pg_proc`.

| Function | Invoker/Definer | `authenticated` EXECUTE | Uses `auth.uid()` | Can touch another user's rows | Inputs validated |
|---|---|---|---|---|---|
| `public.save_checkin(date, jsonb)` | DEFINER (needed: no table write grants) | yes | yes, only source of owner | no | full (see table) |
| `public.create_journey(...)` | DEFINER | yes | yes | no | duration/weights/water/start |
| `public.start_next_journey(...)` | DEFINER | yes | yes | no | as above + mode + window; only after the last day |
| `public.update_water_goal(int)` | DEFINER | yes | yes | no | 500–6 000 |
| `public.set_post_goal(text, numeric)` | DEFINER | yes | yes | no | mode, weight; requires a **server-derived** goal achievement |
| `public.claim_journey_complete()` | DEFINER | yes | yes | no | takes no input; derives from the journey dates |
| `public.handle_new_user()` (trigger) | DEFINER | no | n/a (uses `new.id`) | inserts own profile only | truncates name to 120 |
| `public.touch_updated_at()` (trigger) | INVOKER | no | n/a | no | n/a |
| `private.aal_ok()` | DEFINER (reads `auth.mfa_factors`) | yes — only so RLS can call it | yes | no (returns a boolean about the caller) | n/a |
| `private.grant_achievements / earned_achievements` | INVOKER, called only from DEFINER RPCs | **no** | receives uid from the RPC | only that uid | n/a |
| `private.rate_check / log_security_event / jt / check_journey_params` | INVOKER, internal | **no** | uid from the RPC | only that uid | yes |
| `private.on_auth_user_update / on_auth_mfa_change / on_auth_session_delete` (triggers; **optional file 2026-09-30b**) | DEFINER | **no** | use the row's own user id | log-only; errors swallowed | n/a |

Why DEFINER at all: the browser has no write privilege on the tables, so the trusted write path has to run with the owner's. It is safe here because each function
takes no owner argument, pins `search_path`, uses no dynamic SQL, and has `EXECUTE` revoked from `PUBLIC`/`anon`.
`private` is not in the Data API's exposed schemas, so its functions cannot be called over REST even where a grant exists.

## Residual risks (honest list)
- **Self-reported data.** Achievements are *derived from the user's own entries*: someone can type a goal weight equal to their current weight when first creating a
  journey, or back-date a journey that still ends today, and legitimately "reach" it. The server guarantees an achievement matches the saved data, not that the data is
  true. Journeys that are already over, and rewrites of a journey that has check-ins, are now refused (see *Journey integrity*), but "Journey Complete" stays
  calendar-based, so the rest was not changed.
- **Audit triggers are optional** and depend on Supabase-owned tables; if they cannot be installed, only the login/password/MFA/session audit events are missing.
- **Legacy achievement cleanup is best-effort evidence, not proof** (see its limits above); that is why it quarantines instead of deleting.
- **One account per person** cannot be guaranteed (see the checklist §3).
- **Access tokens live until expiry** (≤ JWT expiry) after a sign-out or password change; refresh tokens are revoked immediately.
- **Failed logins** are visible only in the Supabase Auth logs, not in `security_events`.
- **Website vs API protection:** Vercel's firewall protects the site, not calls the browser makes straight to Supabase (see the checklist §2.4).
- **Dashboard settings** (CAPTCHA secret, Auth rate limits, password policy, MFA enablement, Vercel firewall/deployment protection) are not verifiable from source.
