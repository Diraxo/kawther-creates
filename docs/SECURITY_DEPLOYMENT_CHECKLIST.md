# Security deployment checklist — Kawther | creates

The source code cannot turn on anything in the Supabase or Vercel dashboards. This is the list of what **you** must switch on,
what the code already does, and how to verify each item. Nothing in here is "enabled" merely because the code supports it.

Legend: ✅ done by code in this repo (tested) · 🔧 dashboard action required · 🔑 needs a key only you have

> ## ⚠ Verification status — read first
> The migrations in this repo have **NOT been applied to, or verified against, the hosted production project `qgrbygvtqgeokvyvizwf`.** They are tested only on local
> Postgres (PGlite). The local Supabase CLI has been linked to a *different* project — **confirm the project ref is `qgrbygvtqgeokvyvizwf` (`supabase projects list`,
> the dashboard URL, `supabase/.temp/project-ref`) before running anything.** Production security must not be treated as complete until §0 step 6 is done and its
> checks pass.

---

## 0. Order of operations (first deploy of the hardening)

Order matters. **Do not apply anything to production until steps 1–3 are done.**

1. **Confirm the target.** The project ref must be `qgrbygvtqgeokvyvizwf`. Take a backup / note the PITR restore point first.
2. **Check migrations 2026-09-26 … 2026-09-29 are applied** (the core migration also checks this itself and aborts with a named error if not).
   Older migrations refuse to run once the hardening is present, so apply them first, in date order, each once.
3. 🔧 **Rehearse on a staging/branch copy of production data** (never the live project first). Run the core migration there and read its NOTICEs.
4. 🔧 **Core migration:** run `supabase/migrations/2026-09-30_security_hardening.sql` **once**, as **one execution** (psql `-v ON_ERROR_STOP=1 -f`, or paste the whole
   file into a single SQL-editor run). It is **one transaction** with `lock_timeout = 5s`: any error rolls everything back, nothing is half-applied. If a tool leaves the
   session in an aborted transaction, run `ROLLBACK;`. Re-running is **not** a supported workflow (the structural part is idempotent and the legacy cleanup never repeats,
   but do not rely on it).
   - If it fails on the `aal_ok()` smoke test, the migration role cannot read `auth.mfa_factors`: fix that privilege and re-run; do not edit the function.
   - It performs the **one-time legacy achievement cleanup** (§5): only rows with no historical evidence are quarantined; legitimate history is kept.
   - New project? Run `supabase/schema.sql` instead: it contains everything (core + audit triggers) and is stamped as already clean.
5. 🔧 **Optional audit triggers:** run `supabase/migrations/2026-09-30b_auth_audit_triggers.sql` **after** the core. Skipping it or a WARNING from it does not weaken any
   protection; you only lose login/password/MFA/session audit events. Read its warnings.
6. **Verify on the hosted project** with §4 (SQL), then run `npm run test:live` against **staging**. Only after these pass on `qgrbygvtqgeokvyvizwf` may production security
   be called verified.
7. 🔧 **Supabase → Authentication:** complete §1 (CAPTCHA, rate limits, password policy, redirect URLs, MFA).
8. 🔧 **Vercel:** complete §2, then deploy. `vercel.json` (headers + CSP) ships with the repo. Deploy the app **after** the database migration (the new RPCs must exist).

---

## 1. Supabase dashboard

### 1.1 Authentication → Attack Protection → CAPTCHA (Cloudflare Turnstile) 🔧🔑
1. Cloudflare → Turnstile → **Add widget**. Hostnames: your production domain (and `localhost` only for a dev widget). Mode: *Managed*.
2. Copy the **Site key** (public) → Vercel env var `VITE_TURNSTILE_SITE_KEY` (all environments that should show the check).
3. Copy the **Secret key** → paste it **only** into *Supabase → Authentication → Attack Protection → Enable CAPTCHA protection →
   Turnstile → Secret*. **Never** put the secret in `.env`, Vercel, this repo, or any `VITE_` variable.
4. Effect: Supabase Auth rejects sign-up, sign-in and password-recovery requests without a valid token — **for every client**,
   including scripts that never load this site. The app supplies tokens for sign-up, log-in and the "current password" check.
5. Until step 2–3 are both done the app sends no token and shows no widget. If you enable CAPTCHA in the dashboard **without** the
   site key in Vercel, nobody can log in (the app shows "The security check didn't complete"). Do them together.
6. Cloudflare publishes test keys (`1x00000000000000000000AA` always passes). Use them for a staging project only.
7. Password reset: the app has no "forgot password" screen. If you add one, call `resetPasswordForEmail(email, { captchaToken })`
   with a token from `createCaptcha(...).getToken('recovery')` (`src/lib/turnstile.js`). The dashboard CAPTCHA already protects the endpoint.

### 1.2 Authentication → Rate Limits 🔧
Recommended starting values (tighten if you see abuse; every change is instant):

| Limit | Value |
|---|---|
| Sign-ups and sign-ins (per IP, per 5 min) | **20** (default 30) |
| Token refreshes (per IP, per 5 min) | 150 |
| Token verifications (OTP/MFA per IP, per 5 min) | **20** |
| Emails sent per hour | 30 (raise only with custom SMTP) |
| SMS/anonymous sign-ins | disabled (the app uses neither) |

- 🔧 **Authentication → Sign In / Providers:** *Allow new users to sign up* ON (public app). **Anonymous sign-ins OFF.** Phone OFF. Only *Email* provider ON.
- 🔧 **Custom SMTP** for production (the built-in mailer is heavily rate-limited and shared).

### 1.3 Authentication → Sign In / Providers → Email
- **Confirm email — decision:** turn **ON** for the public launch. It stops throw-away addresses being used to mass-create accounts
  and proves the address exists. Trade-off: the live test suites (`npm run test:live`) create accounts and log in straight away, so they need
  it **OFF**. Run them against a **separate staging Supabase project**, never against production with it ON/OFF toggled back and forth.
  The app already handles both (`CONFIRM_EMAIL` state).
- **Password policy:** minimum length **10** (the app's own check is 8; the server value wins), require lower + upper + digits.
  If your plan includes it, enable **Leaked password protection**.
- **Secure password change:** ON (requires a recent login). **Secure email change:** ON.

### 1.4 Authentication → URL Configuration 🔧
- **Site URL:** `https://<your production domain>` (exact, no wildcard).
- **Redirect URLs:** exact production URL only. Remove `localhost` and any `*` preview wildcards from the production project.
- The client uses the **PKCE** flow: auth codes arrive as `?code=` and are exchanged with a verifier that never leaves the browser;
  tokens are not placed in URLs.

### 1.5 Authentication → Sessions 🔧
- **JWT expiry:** 3600 s (default). Do not raise it.
- **Refresh token rotation:** ON; **reuse interval:** 10 s.
- Plan permitting: **Time-box user sessions** (e.g. 7 days) and **inactivity timeout** (e.g. 24 h) for the creator's project.
- Logout in the app uses Supabase's default **global** scope: it ends the session on **every** device. Changing the password also ends every
  *other* session. To end other devices without logging out here, use `supabase.auth.signOut({ scope: 'others' })`.
  Already-issued access tokens stay valid until they expire (≤ JWT expiry); that is inherent to JWTs — keep expiry short.

### 1.6 Authentication → Multi-Factor (creator account) 🔧
1. *Sign In / Providers → Multi-Factor Authentication →* **TOTP: Enabled**. Set *Maximum enrolled factors* to **at least 2** (needed for the recovery plan).
2. The creator signs in, opens **Profile → Two-factor authentication → Set up**, scans the QR code, **saves the setup key in a password manager**,
   and enters a code. From that moment the **database** refuses password-only sessions for that account (restrictive RLS + every RPC checks `aal2`).
3. **Recovery strategy** (do all three *before* relying on it):
   1. Enrol a **second** authenticator (second phone / password-manager TOTP): *Two-factor authentication → Add another authenticator*.
   2. Keep the setup key from step 2 in the password manager (it re-creates the authenticator on any device).
   3. Break-glass (project owner only): *Authentication → Users → the user → Delete factor* in the dashboard, or from a trusted machine
      `supabase.auth.admin.mfa.deleteFactor({ id, userId })` with the service-role key. The service-role key must **never** be in the browser or this repo.
- MFA is opt-in for every user; it is **not** forced on normal users.

### 1.7 Database / API 🔧
- **Data API → Exposed schemas:** `public` only (the helpers live in `private`, which must **not** be added). Disable *GraphQL* if unused.
- **Run the advisors** (Dashboard → Advisors → Security, or `supabase db advisors --linked --type security`) after the migration; expect no ERROR-level items.
- Never copy the `service_role` / `sb_secret_…` key into Vercel, `.env`, or the repo.
- Enforce SSL; restrict database network access to what you need; enable Point-in-Time Recovery/backups.

### 1.8 Suspicious-activity and audit trail
`public.security_events` records: `signup`, `login`, `password_change`, `password_reset_request`, `mfa_enabled`, `mfa_disabled`,
`session_revoked`, `rate_limited`, `suspicious_activity`. It never stores passwords, tokens, CAPTCHA data, e-mail addresses or IPs.
Users can read only their own rows; only trusted database code can write. Failed logins are **not** available to the database
(GoTrue does not expose them): use *Authentication → Logs* in the dashboard or a log drain.

```sql
-- who is being throttled / flagged (run in the SQL editor; you bypass RLS there)
select event_type, count(*), max(created_at) from public.security_events
 where created_at > now() - interval '24 hours' group by 1 order by 2 desc;
select user_id, count(*) from public.security_events
 where event_type in ('rate_limited','suspicious_activity') and created_at > now() - interval '24 hours' group by 1 order by 2 desc;
```
A `suspicious_activity` row with `reason = signup_spike_10m` means ≥ 30 sign-ups in 10 minutes: tighten §1.2 and check Cloudflare/Vercel.

---

## 2. Vercel

### 2.1 Environment variables (Project → Settings → Environment Variables)

| Variable | Browser-visible? | Value | Environments |
|---|---|---|---|
| `VITE_DATA_BACKEND` | yes (public) | `supabase` | Production, Preview |
| `VITE_SUPABASE_URL` | yes (public) | `https://<ref>.supabase.co` | Production, Preview |
| `VITE_SUPABASE_ANON_KEY` | yes (public, RLS-protected) | the **anon / publishable** key | Production, Preview |
| `VITE_TURNSTILE_SITE_KEY` | yes (public) | Turnstile **site** key | Production (Preview: a test/staging key) |

Every `VITE_*` variable is compiled into the public JavaScript. **Server secrets:** there are **none** in this app's Vercel project.
The Turnstile **secret** lives in the Supabase dashboard; the service-role key lives nowhere in this project. If you ever add a variable
that is secret, its name must **not** start with `VITE_`.
Use a **separate Supabase project** for Preview/staging so preview deployments never touch production data.

### 2.2 Production domain 🔧
Add the custom domain, force HTTPS, redirect `www` ↔ apex. After the site has run cleanly on HTTPS for a while you may add `; preload`
to the HSTS header in `vercel.json` and submit the domain to hstspreload.org (that step is hard to reverse, so it is not enabled).

### 2.3 Deployment Protection 🔧
*Settings → Deployment Protection:* **Standard Protection** (Vercel Authentication) for Preview deployments, so unfinished builds — which contain your anon
key and Supabase URL — are not public. Enable *Protection Bypass for Automation* only if a CI job needs it.

### 2.4 Firewall / WAF / bot protection 🔧
*Project → Firewall:*
- Turn on the **managed Bot Protection** ruleset (challenge mode) and the **OWASP core** ruleset if your plan offers it.
- Add a **rate-limit rule** on `/*` (e.g. 300 requests / minute / IP → challenge or 429) to blunt scraping and asset floods.
- Keep **Attack Challenge Mode** ready to switch on during an incident.
- **Be clear about what this covers:** the browser talks to Supabase **directly**, not through Vercel. Vercel's firewall protects the *website*; it does
  **not** see or limit calls to `https://<ref>.supabase.co`. Protection of those calls is: Supabase Auth rate limits (§1.2) + Turnstile (§1.1) +
  the database's per-user rate limits and RLS (in this repo) + Supabase's own edge limits. For per-IP control in front of Supabase you would need a
  Supabase custom domain behind Cloudflare with rate-limit rules (optional, not set up here).

### 2.5 Headers ✅
`vercel.json` sets: Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy and a
Content-Security-Policy built from what the app actually loads (Supabase `*.supabase.co`, Google Fonts, Cloudflare Turnstile, same-origin assets, `data:`/`blob:`
images). The inline theme script was moved to `/theme-init.js` so scripts need no `unsafe-inline`.
If you later add a Supabase **custom domain**, add it to `connect-src`. Verify after deploy: <https://securityheaders.com>.

---

## 3. One account per person — what is and is not possible

A public sign-up form **cannot** guarantee one account per human without identity verification (ID / phone / payment), which this product deliberately
does not collect. Browser fingerprinting is unreliable and invasive and is **not** used. What is layered instead:

1. Unique e-mail (Supabase Auth) — duplicates return `EXISTS`.
2. Confirm-email ON (§1.3) — the address must be real and reachable.
3. Turnstile on sign-up and log-in (§1.1).
4. Supabase Auth per-IP rate limits (§1.2).
5. Database per-user write limits (`save_checkin` 30/5 min & 400/day, `create_journey` 10/h, …) — a farmed account cannot flood the database.
6. Signup-spike detection → `suspicious_activity` in `security_events` (log/alert only; it never blocks or bans anyone).
7. Vercel firewall / bot rules for the website (§2.4).

Enforcement is **temporary throttling**, never permanent automatic bans, so a false positive costs a user a few minutes, not their account.
If you ever need stronger uniqueness (e.g. a giveaway), add phone/OTP or another verified identity — a product decision, not a code toggle.

---

## 4. Verify the database after applying the migration (SQL editor)

```sql
-- 1. the browser has no write privilege anywhere; only SELECT (+ profiles.full_name UPDATE)
select table_name, privilege_type from information_schema.role_table_grants
 where grantee = 'authenticated' and table_schema = 'public' order by 1, 2;
select table_name, column_name from information_schema.column_privileges
 where grantee = 'authenticated' and table_schema = 'public' and privilege_type <> 'SELECT';
-- 2. anon has nothing
select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public';
-- 3. every function: definer?, pinned search_path?, who can execute?
select n.nspname, p.proname, p.prosecdef as definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') order by 1, 2;
-- 4. RLS everywhere, policies scoped to auth.uid()
select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r';
select tablename, policyname, cmd, permissive, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2;
-- 5. what the cleanup moved out (nothing = nothing was forged) and that it ran exactly once
select * from private.achievements_quarantine;
select * from private.schema_markers;   -- expect one row: legacy_achievement_cleanup
-- 6. exactly the intended policies on the six tables (7 permissive select/update + 6 restrictive "mfa aal2"; nothing else)
select tablename, policyname, permissive, cmd from pg_policies where schemaname = 'public'
  and tablename in ('profiles','journeys','checkins','checkin_meals','user_achievements','security_events') order by 1, 2;
-- 7. the smoke test the migration ran: must return true for a session without MFA
select private.aal_ok();
-- 8. optional audit triggers present? (0 rows = optional file not applied or refused; the core is unaffected)
select tgrelid::regclass, tgname from pg_trigger where tgname like 'kc\_%';
```
Expected: `authenticated` has `SELECT` on the 6 tables and `UPDATE(full_name)` on `profiles`, nothing else; `anon` has no rows; `authenticated` can execute exactly
`save_checkin, create_journey, start_next_journey, update_water_goal, set_post_goal, claim_journey_complete` and `private.aal_ok`; every function has `search_path=""`.

---

## 5. Quarantine and rollback of the cleanup

The cleanup runs **once**, and keeps every achievement that the user's own history supports (a finished journey's achievements, a goal reached before the weight moved
again, a consistency or hydration streak that later dropped, a water goal raised since). It quarantines only rows with **no** such evidence. Details and limits:
docs/SECURITY_MODEL.md → *Achievement immutability and history*.

If a genuine achievement was still quarantined (e.g. the check-in that proved it was later overwritten), an admin can restore it:
```sql
insert into public.user_achievements (user_id, achievement_id, unlocked_on)
select user_id, achievement_id, unlocked_on from private.achievements_quarantine
 where user_id = '<uuid>' and achievement_id = '<id>' on conflict do nothing;
```
Nothing else in the migration deletes user data.

---

## 6. Environment / secrets hygiene before every commit
- `.env` and `.env.local` are git-ignored; only `.env.example` (no values) is committed. Tests fail if a JWT-looking string or `sb_secret_` appears in tracked file types.
- The service-role key, Turnstile secret, database password and access tokens must never be committed, pasted into an issue, or placed in a `VITE_` variable.
- Rotate the anon key from Supabase (*Settings → API*) if it was ever pasted somewhere it should not be; the anon key is public by design, but rotate it if abused.

## 7. Tests
| Command | What it proves |
|---|---|
| `npm test` | unit: Turnstile configured/unconfigured, RPC-only writes, rate-limit errors, MFA routing, CSP/headers, no secrets |
| `npm run test:db` | real Postgres (PGlite): RLS, grants, forgery + direct-write attacks, validation & volume limits, rate limits, security events, MFA enforcement, function/grant inventory, JS↔SQL achievement parity, upgrade path, **migration atomicity, prerequisite guards, stray-policy cleanup, achievement-history preservation (journey-2 regression), one-time cleanup, aal_ok smoke test, audit-trigger isolation, journey date protection, repository ↔ RPC contract** |
| `npm run test:headers` | the production build served with `vercel.json` headers: no CSP violations, Supabase + Turnstile still work |
| `npm run test:live` | the real Supabase project (staging!): the same attacks from raw supabase-js, real TOTP MFA, real rate limits, then the browser suites |
| `npm run test:ux` | browser UX suite (needs the migration applied on the project in `.env`) |

Live tests create throw-away `kc.test.*` accounts. Deleting auth users needs the service-role key (deliberately absent), so delete them by hand in
*Authentication → Users* on the **staging** project when you like.
