-- Security hardening - CORE (2026-09-30). Apply ONCE, after schema.sql and migrations 2026-09-26 .. 2026-09-29.
--   * user_achievements / journeys / checkins / checkin_meals: the browser loses ALL direct write privileges.
--     Writes go only through trusted RPCs that validate, rate-limit and (for achievements) derive from real data.
--   * new RPCs: update_water_goal, set_post_goal, claim_journey_complete; save_checkin / create_journey / start_next_journey
--     are rebuilt (SECURITY DEFINER, search_path = '', return {ok,...} JSON so a rate-limit hit is a clean result).
--   * ALL policies on the six protected tables are dropped and only the intended ones are recreated (deterministic result).
--   * security_events audit table, per-user sliding-window rate limits, MFA (aal2) enforcement for users who enrolled.
--   * create_journey / start_next_journey refuse journeys that are already over, and freeze a journey's history once it has check-ins.
--   * legacy achievement rows are inspected ONCE (see the end of this file): rows with no historical evidence are moved to
--     private.achievements_quarantine; every row that history supports is kept, even if today's data no longer shows it.
--
-- TRANSACTION: the whole file is ONE transaction (begin ... commit) with lock_timeout = 5s. A missing prerequisite, a lock
-- that cannot be taken within 5s, or a failing smoke test aborts everything - nothing is left half-applied. Run it as a single
-- execution: psql -v ON_ERROR_STOP=1 -f <this file>, or paste the whole file into ONE SQL-editor run. Do not run it
-- statement by statement. If a tool leaves the session in an aborted transaction after an error, run ROLLBACK;.
-- Every statement here is transaction-safe (there is no CREATE INDEX CONCURRENTLY or VACUUM).
--
-- RE-RUNNING: apply once. The structural part is idempotent, and the legacy achievement cleanup is guarded by a marker
-- (private.schema_markers) so it never runs twice - but a re-run is not a supported workflow.
-- NOT in this file: the optional auth-table audit triggers (2026-09-30b_auth_audit_triggers.sql). Nothing here depends on them.
-- Older migrations now refuse to run (they would re-open direct writes); apply migrations once, in date order.

begin;
set local lock_timeout = '5s';

-- ---------- prerequisites: fail early with a clear message, never later with an obscure one ----------
do $$
declare
  missing text[] := '{}';
  need_tables text[] := array['public.profiles', 'public.journeys', 'public.checkins', 'public.checkin_meals',
                              'public.user_achievements', 'auth.users', 'auth.mfa_factors'];
  need_cols text[] := array['public.journeys.completed_on', 'public.journeys.post_goal_mode', 'public.journeys.next_goal_weight',
                            'public.checkins.exercise_unit'];
  t text; c text; rel text; col text;
begin
  foreach t in array need_tables loop
    if to_regclass(t) is null then missing := array_append(missing, 'table ' || t); end if;
  end loop;
  foreach c in array need_cols loop
    rel := regexp_replace(c, '\.[^.]+$', '');
    col := regexp_replace(c, '^.*\.', '');
    if to_regclass(rel) is not null and not exists (
      select 1 from pg_attribute a where a.attrelid = to_regclass(rel) and a.attname = col and a.attnum > 0 and not a.attisdropped
    ) then
      missing := array_append(missing, 'column ' || c);
    end if;
  end loop;
  if to_regclass('public.journeys_one_active_per_user') is null then
    missing := array_append(missing, 'index public.journeys_one_active_per_user (migration 2026-09-29)');
  end if;
  if to_regclass('public.user_achievements') is not null and not exists (
    select 1 from pg_constraint k
    where k.conrelid = to_regclass('public.user_achievements') and k.contype = 'c' and pg_get_constraintdef(k.oid) like '%''journey''%'
  ) then
    missing := array_append(missing, 'user_achievements check allowing the journey achievement (migration 2026-09-29)');
  end if;
  if to_regprocedure('auth.uid()') is null then missing := array_append(missing, 'function auth.uid()'); end if;
  if to_regprocedure('auth.jwt()') is null then missing := array_append(missing, 'function auth.jwt()'); end if;
  if cardinality(missing) > 0 then
    raise exception 'security hardening cannot run - missing prerequisites: %. Apply schema.sql and migrations 2026-09-26 .. 2026-09-29 first. Nothing was changed.',
      array_to_string(missing, '; ') using errcode = '55000';
  end if;
end $$;

-- Decide NOW (before the section below creates the quarantine table) whether the legacy achievement cleanup is still due.
-- It is due exactly once: never if the marker is set, and never if an earlier revision of this migration already ran it
-- (that revision created the quarantine table).
do $$
declare needed boolean := true;
begin
  if to_regclass('private.achievements_quarantine') is not null then
    needed := false;
  elsif to_regclass('private.schema_markers') is not null then
    needed := not exists (select 1 from private.schema_markers m where m.name = 'legacy_achievement_cleanup');
  end if;
  perform set_config('kawther.legacy_cleanup', needed::text, true); -- transaction-local
end $$;

-- >>> SECURITY HARDENING (kept byte-identical in schema.sql and supabase/migrations/2026-09-30_security_hardening.sql; tests enforce it)
--
-- Threat model: the anon key is public and every browser is hostile. The frontend is NOT a security boundary.
--   * The browser can READ its own rows (RLS) and call a small set of RPCs. It has NO direct write privilege on any
--     application table, so nothing can bypass the validation, volume limits, rate limits and achievement derivation
--     that live inside the RPCs.
--   * The RPCs are SECURITY DEFINER *because* the browser has no write grants. Each one is hardened the same way:
--     search_path = '' (every object schema-qualified), ownership taken ONLY from auth.uid(), never from an argument,
--     no dynamic SQL, EXECUTE revoked from PUBLIC/anon and granted to `authenticated` only.
--   * Helpers live in the `private` schema, which the Data API does not expose.

-- ---------- private schema: rate-limit ledger, quarantine, helpers ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- USAGE only so that RLS policies (evaluated as the caller) can call private.aal_ok(). No table or other function is granted.
grant usage on schema private to authenticated;

create table if not exists private.rate_events (
  user_id  uuid        not null,
  bucket   text        not null,
  at       timestamptz not null default now()
);
create index if not exists rate_events_lookup on private.rate_events (user_id, bucket, at);
alter table private.rate_events enable row level security; -- no policies: only the owner role reaches it

-- Legacy achievement rows that NO historical evidence supported when the hardening migration ran (forged). Kept, not deleted.
create table if not exists private.achievements_quarantine (
  user_id        uuid        not null,
  achievement_id text        not null,
  unlocked_on    date        not null,
  quarantined_at timestamptz not null default now()
);
alter table private.achievements_quarantine enable row level security;

-- One-time work markers. The hardening migration stamps 'legacy_achievement_cleanup' when it has inspected the legacy
-- achievement rows, so that step can never run (and quarantine anything) a second time.
create table if not exists private.schema_markers (
  name       text        primary key,
  applied_at timestamptz not null default now()
);
alter table private.schema_markers enable row level security;
revoke all on private.rate_events, private.achievements_quarantine, private.schema_markers from public, anon, authenticated;

-- ---------- security events (append-only audit trail; written only by trusted server code) ----------
-- Never stores passwords, tokens, CAPTCHA secrets, e-mail addresses or IPs. `user_id` deliberately has no foreign key so a
-- trigger writing an event can never block an auth operation (or an account deletion).
create table if not exists public.security_events (
  id          bigint generated always as identity primary key,
  user_id     uuid,
  event_type  text        not null check (event_type in (
                'signup','login','password_change','password_reset_request','mfa_enabled','mfa_disabled',
                'session_revoked','rate_limited','suspicious_activity','security_action')),
  details     jsonb       not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 1024),
  created_at  timestamptz not null default now()
);
create index if not exists security_events_user_idx on public.security_events (user_id, created_at desc);
create index if not exists security_events_type_idx on public.security_events (event_type, created_at desc);

-- ---------- housekeeping ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

drop trigger if exists checkins_touch on public.checkins;
create trigger checkins_touch before update on public.checkins
  for each row execute function public.touch_updated_at();

-- ---------- private helpers (never callable through the Data API) ----------
create or replace function private.jt(v jsonb) returns text
language sql immutable set search_path = '' as $$ select coalesce(jsonb_typeof(v), 'null') $$;

-- Appends a security event. `p_dedupe` suppresses a repeat of the same event for the same user inside that interval.
create or replace function private.log_security_event(
  p_user uuid, p_type text, p_details jsonb default '{}'::jsonb, p_dedupe interval default null
) returns void
language plpgsql set search_path = '' as $$
begin
  if p_dedupe is not null and exists (
    select 1 from public.security_events e
    where e.user_id is not distinct from p_user and e.event_type = p_type and e.created_at > now() - p_dedupe
  ) then
    return;
  end if;
  insert into public.security_events (user_id, event_type, details) values (p_user, p_type, coalesce(p_details, '{}'::jsonb));
  if p_user is not null and p_type in ('login', 'signup') then -- bounded retention, pruned lazily
    delete from public.security_events e where e.user_id = p_user and e.created_at < now() - interval '180 days';
  end if;
end $$;

-- TRUE when the session may act. A user with a VERIFIED MFA factor must be on an aal2 session (a password alone is not
-- enough); users without MFA are unaffected. Fail-closed: no jwt claim means aal1.
create or replace function private.aal_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
$$;

-- Sliding-window rate limit per (user, bucket) with a short and a long window. Returns 0 when the call is allowed (and
-- records it), otherwise the number of seconds to wait. Only ALLOWED calls are recorded, so a blocked client is never
-- locked out longer than the window. Serialised per (user, bucket) so parallel requests cannot slip past the count.
create or replace function private.rate_check(
  p_uid uuid, p_bucket text, p_max_short int, p_short interval, p_max_long int, p_long interval
) returns int
language plpgsql set search_path = '' as $$
declare
  n_short int; n_long int; oldest_short timestamptz; oldest_long timestamptz; free_at timestamptz; wait int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_uid::text || ':' || p_bucket, 0));
  delete from private.rate_events r where r.user_id = p_uid and r.bucket = p_bucket and r.at <= now() - p_long;
  select count(*) filter (where r.at > now() - p_short), count(*),
         min(r.at) filter (where r.at > now() - p_short), min(r.at)
    into n_short, n_long, oldest_short, oldest_long
  from private.rate_events r where r.user_id = p_uid and r.bucket = p_bucket;

  if n_short >= p_max_short or n_long >= p_max_long then
    free_at := greatest(
      case when n_short >= p_max_short then oldest_short + p_short end,
      case when n_long  >= p_max_long  then oldest_long  + p_long  end);
    wait := greatest(1, ceil(extract(epoch from (free_at - now())))::int);
    perform private.log_security_event(p_uid, 'rate_limited', jsonb_build_object('bucket', p_bucket), interval '1 minute');
    if (select count(*) from public.security_events e
        where e.user_id = p_uid and e.event_type = 'rate_limited' and e.created_at > now() - interval '1 day') >= 10 then
      perform private.log_security_event(p_uid, 'suspicious_activity', jsonb_build_object('reason', 'repeated_rate_limit', 'bucket', p_bucket), interval '1 day');
    end if;
    return wait;
  end if;
  insert into private.rate_events (user_id, bucket) values (p_uid, p_bucket);
  return 0;
end $$;

-- Journey parameter validation shared by create_journey / start_next_journey. Messages are stable and reveal nothing internal.
create or replace function private.check_journey_params(p_duration int, p_start_weight numeric, p_goal_weight numeric, p_water_goal int)
returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_duration is null or p_duration not between 7 and 365 then
    raise exception 'invalid journey: duration_days violates the allowed range 7-365' using errcode = '22023';
  end if;
  if p_start_weight is null or p_start_weight not between 30 and 300 then
    raise exception 'invalid journey: start_weight violates the allowed range 30-300 kg' using errcode = '22023';
  end if;
  if p_goal_weight is null or p_goal_weight not between 30 and 300 then
    raise exception 'invalid journey: goal_weight violates the allowed range 30-300 kg' using errcode = '22023';
  end if;
  if p_water_goal is null or p_water_goal not between 500 and 6000 then
    raise exception 'invalid journey: water_goal_ml violates the allowed range 500-6000' using errcode = '22023';
  end if;
end $$;

-- ---------- achievements: DERIVED from real rows, never accepted from a client ----------
-- The rules are the ones in src/domain/achievements.js (a parity test runs both on the same data):
--   first       1+ check-ins.
--   d3/d7/d14   longest run of consecutive check-in days (up to p_today) reaches 3 / 7 / 14.
--   hydrated    7 check-ins whose water met the ACTIVE journey's water goal.
--   active      4 check-ins with a workout inside any 7-day window.
--   consistent  >= 7 check-ins AND >= 80% of the active journey's days so far have one.
--   goal        a check-in inside the active journey reached that journey's goal weight (gain or loss); dated to that day.
--   journey     the active journey's last day (start + duration - 1) has arrived; dated to that day.
create or replace function private.earned_achievements(p_uid uuid, p_today date)
returns table (aid text, aon date)
language plpgsql stable set search_path = '' as $$
declare
  j public.journeys%rowtype;
  n int; best int; hyd int; wk int; inj int; dayidx int; cons int; gdate date; dir text; last_day date;
begin
  select * into j from public.journeys jj where jj.user_id = p_uid and jj.completed_on is null;
  if not found then return; end if;

  select count(*) into n from public.checkins c where c.user_id = p_uid;
  if n >= 1 then aid := 'first'; aon := p_today; return next; end if;

  select coalesce(max(len), 0) into best from (
    select count(*) as len from (
      select c.checkin_date - (row_number() over (order by c.checkin_date))::int as g
      from public.checkins c where c.user_id = p_uid and c.checkin_date <= p_today
    ) s group by s.g
  ) r;
  if best >= 3  then aid := 'd3';  aon := p_today; return next; end if;
  if best >= 7  then aid := 'd7';  aon := p_today; return next; end if;
  if best >= 14 then aid := 'd14'; aon := p_today; return next; end if;

  select count(*) into hyd from public.checkins c where c.user_id = p_uid and c.water_ml >= j.water_goal_ml;
  if hyd >= 7 then aid := 'hydrated'; aon := p_today; return next; end if;

  if (select count(*) from public.checkins c where c.user_id = p_uid and c.exercise_type is not null) >= 4 then
    select coalesce(max(cnt), 0) into wk from (
      select (select count(*) from public.checkins c2
              where c2.user_id = p_uid and c2.exercise_type is not null
                and c2.checkin_date >= c1.checkin_date and c2.checkin_date < c1.checkin_date + 7) as cnt
      from public.checkins c1 where c1.user_id = p_uid
    ) t;
    if wk >= 4 then aid := 'active'; aon := p_today; return next; end if;
  end if;

  select count(*) into inj from public.checkins c
    where c.user_id = p_uid and c.checkin_date >= j.start_date and c.checkin_date <= p_today;
  dayidx := greatest(1, least(j.duration_days, (p_today - j.start_date) + 1));
  cons := round(inj * 100.0 / dayidx);
  if n >= 7 and cons >= 80 then aid := 'consistent'; aon := p_today; return next; end if;

  dir := case when j.goal_weight > j.start_weight then 'gain' when j.goal_weight < j.start_weight then 'loss' else 'none' end;
  if dir <> 'none' then
    select min(c.checkin_date) into gdate from public.checkins c
    where c.user_id = p_uid and c.checkin_date >= j.start_date and c.weight_kg is not null
      and ((dir = 'gain' and c.weight_kg >= j.goal_weight) or (dir = 'loss' and c.weight_kg <= j.goal_weight));
    if gdate is not null then aid := 'goal'; aon := gdate; return next; end if;
  end if;

  last_day := j.start_date + (j.duration_days - 1);
  if p_today >= last_day then aid := 'journey'; aon := last_day; return next; end if;
end $$;

-- Records every achievement in `p_only` that the data now earns, and returns [{id, on}] for the NEWLY granted ones.
-- Insert-only apart from one case: a goal/journey unlock dated before the ACTIVE journey began belongs to a finished
-- journey, so a genuinely re-earned one replaces it. Nothing here reads a client-supplied achievement or date.
create or replace function private.grant_achievements(p_uid uuid, p_today date, p_only text[])
returns jsonb
language plpgsql set search_path = '' as $$
declare j public.journeys%rowtype; res jsonb;
begin
  select * into j from public.journeys jj where jj.user_id = p_uid and jj.completed_on is null;
  if not found then return '[]'::jsonb; end if;
  with granted as (
    insert into public.user_achievements as ua (user_id, achievement_id, unlocked_on)
    select p_uid, e.aid, e.aon from private.earned_achievements(p_uid, p_today) e where e.aid = any (p_only)
    on conflict (user_id, achievement_id) do update set unlocked_on = excluded.unlocked_on
      where ua.achievement_id in ('goal', 'journey') and ua.unlocked_on < j.start_date
    returning ua.achievement_id as gid, ua.unlocked_on as gon
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', g.gid, 'on', g.gon)
           order by array_position(array['first','d3','d7','d14','hydrated','active','consistent','goal','journey'], g.gid)), '[]'::jsonb)
    into res from granted g;
  return res;
end $$;

revoke all on function private.jt(jsonb)                                                       from public, anon, authenticated;
revoke all on function private.log_security_event(uuid, text, jsonb, interval)                 from public, anon, authenticated;
revoke all on function private.aal_ok()                                                        from public, anon, authenticated;
revoke all on function private.rate_check(uuid, text, int, interval, int, interval)            from public, anon, authenticated;
revoke all on function private.check_journey_params(int, numeric, numeric, int)                from public, anon, authenticated;
revoke all on function private.earned_achievements(uuid, date)                                 from public, anon, authenticated;
revoke all on function private.grant_achievements(uuid, date, text[])                          from public, anon, authenticated;
grant execute on function private.aal_ok() to authenticated; -- RLS policies call it as the signed-in user

-- ---------- new-user trigger (profile row + signup event) ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120), coalesce(new.email, ''));
  begin -- auditing must never be able to block a signup
    perform private.log_security_event(new.id, 'signup');
    if (select count(*) from public.security_events e where e.event_type = 'signup' and e.created_at > now() - interval '10 minutes') >= 30 then
      perform private.log_security_event(null, 'suspicious_activity', jsonb_build_object('reason', 'signup_spike_10m'), interval '10 minutes');
    end if;
  exception when others then null;
  end;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- privileges: the browser may READ its own rows and write nothing directly ----------
-- Supabase grants ALL on new public tables to anon/authenticated by default; take that away.
revoke all on public.profiles, public.journeys, public.checkins, public.checkin_meals, public.user_achievements, public.security_events
  from anon, authenticated;

grant select on public.profiles, public.journeys, public.checkins, public.checkin_meals, public.user_achievements, public.security_events
  to authenticated;
grant update (full_name) on public.profiles to authenticated; -- the only client-writable column anywhere; id/email/onboarded are not
-- Everything else is written ONLY by the RPCs below (journeys, check-ins, meals, achievements, security events).

-- ---------- row level security: users only ever see their own rows ----------
alter table public.profiles          enable row level security;
alter table public.journeys          enable row level security;
alter table public.checkins          enable row level security;
alter table public.checkin_meals     enable row level security;
alter table public.user_achievements enable row level security;
alter table public.security_events   enable row level security;

-- Drop EVERY existing policy on these six tables, whatever it is called (dashboard-created, experimental, or left over from an
-- older revision), so the result is exactly the policies below and nothing else. Only these six tables are touched.
do $$
declare pol record;
begin
  for pol in
    select p.schemaname, p.tablename, p.policyname from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('profiles', 'journeys', 'checkins', 'checkin_meals', 'user_achievements', 'security_events')
  loop
    execute format('drop policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

create policy "profiles select" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "profiles update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "journeys select" on public.journeys          for select to authenticated using (user_id = (select auth.uid()));
create policy "checkins select" on public.checkins          for select to authenticated using (user_id = (select auth.uid()));
create policy "meals select"    on public.checkin_meals     for select to authenticated using (user_id = (select auth.uid()));
create policy "ach select"      on public.user_achievements for select to authenticated using (user_id = (select auth.uid()));
create policy "events select"   on public.security_events   for select to authenticated using (user_id = (select auth.uid()));

-- MFA enforcement: once a user has a verified factor, an aal1 session (password only) sees nothing. RESTRICTIVE policies
-- are ANDed with the ones above. Users without MFA are unaffected.
create policy "mfa aal2" on public.profiles          as restrictive for all to authenticated using ((select private.aal_ok()));
create policy "mfa aal2" on public.journeys          as restrictive for all to authenticated using ((select private.aal_ok()));
create policy "mfa aal2" on public.checkins          as restrictive for all to authenticated using ((select private.aal_ok()));
create policy "mfa aal2" on public.checkin_meals     as restrictive for all to authenticated using ((select private.aal_ok()));
create policy "mfa aal2" on public.user_achievements as restrictive for all to authenticated using ((select private.aal_ok()));
create policy "mfa aal2" on public.security_events   as restrictive for all to authenticated using ((select private.aal_ok()));

-- ---------- trusted RPCs (the ONLY write path for the browser) ----------
-- Contract: validation problems RAISE (clean, stable messages); a rate-limit hit RETURNS {ok:false, code:'rate_limited',
-- retry_after} so the event log entry survives (a raise would roll it back). Success returns {ok:true, ...}.
drop function if exists public.save_checkin(date, jsonb);
drop function if exists public.create_journey(date, int, numeric, numeric, int);
drop function if exists public.start_next_journey(date, int, numeric, numeric, int, text);

-- Upserts the day's check-in and replaces its meals, atomically, then grants any achievements the data now earns.
-- p_checkin: { mood, weight_kg, water_ml, exercise_type, exercise_minutes, exercise_unit, notes,
--              meals: [{ category, name, notes, eaten_at, position }] }
-- Volume: one check-in per user per date (unique), one workout per check-in, one water total per check-in,
-- at most 30 meals per day. Dates: at most tomorrow (time-zone slack) and at most 400 days back.
create or replace function public.save_checkin(p_date date, p_checkin jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  cid uuid;
  meals jsonb;
  m jsonb;
  ord bigint;
  n numeric;
  v_weight numeric; v_water int := 0; v_mood text; v_ex_type text; v_ex_min int; v_unit text; v_notes text;
  wait int;
  unlocked jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not private.aal_ok() then
    raise exception 'mfa_required' using errcode = '28000';
  end if;
  if p_date is null or p_date > current_date + 1 or p_date < current_date - 400 then
    raise exception 'invalid check-in date' using errcode = '22007';
  end if;
  if p_checkin is null or jsonb_typeof(p_checkin) <> 'object' or octet_length(p_checkin::text) > 100000 then
    raise exception 'invalid check-in payload' using errcode = '22023';
  end if;
  if not exists (select 1 from public.journeys jr where jr.user_id = uid and jr.completed_on is null) then
    raise exception 'no active journey' using errcode = 'P0002';
  end if;

  -- weight_kg
  if private.jt(p_checkin -> 'weight_kg') not in ('number', 'null') then
    raise exception 'invalid check-in payload: weight_kg must be a number' using errcode = '22023';
  end if;
  v_weight := (p_checkin ->> 'weight_kg')::numeric;
  if v_weight is not null and v_weight not between 30 and 300 then
    raise exception 'invalid check-in payload: weight_kg violates the allowed range 30-300' using errcode = '22023';
  end if;
  -- water_ml
  if private.jt(p_checkin -> 'water_ml') not in ('number', 'null') then
    raise exception 'invalid check-in payload: water_ml must be a whole number' using errcode = '22023';
  end if;
  if private.jt(p_checkin -> 'water_ml') = 'number' then
    n := (p_checkin ->> 'water_ml')::numeric;
    if n <> trunc(n) or n < 0 or n > 20000 then
      raise exception 'invalid check-in payload: water_ml violates the allowed range 0-20000' using errcode = '22023';
    end if;
    v_water := n::int;
  end if;
  -- mood
  if private.jt(p_checkin -> 'mood') not in ('string', 'null') then
    raise exception 'invalid check-in payload: mood must be text' using errcode = '22023';
  end if;
  v_mood := nullif(p_checkin ->> 'mood', '');
  if v_mood is not null and v_mood not in ('great', 'good', 'okay', 'tired', 'low') then
    raise exception 'invalid check-in payload: unknown mood' using errcode = '22023';
  end if;
  -- exercise (one workout per day: a type + whole minutes, both or neither)
  if private.jt(p_checkin -> 'exercise_type') not in ('string', 'null') or private.jt(p_checkin -> 'exercise_minutes') not in ('number', 'null') then
    raise exception 'invalid check-in payload: exercise fields have the wrong type' using errcode = '22023';
  end if;
  v_ex_type := nullif(p_checkin ->> 'exercise_type', '');
  if v_ex_type is not null and char_length(v_ex_type) > 60 then
    raise exception 'invalid check-in payload: exercise_type is too long (max 60)' using errcode = '22023';
  end if;
  if private.jt(p_checkin -> 'exercise_minutes') = 'number' then
    n := (p_checkin ->> 'exercise_minutes')::numeric;
    if n <> trunc(n) or n < 0 or n > 1440 then
      raise exception 'invalid check-in payload: exercise_minutes violates the allowed range 0-1440' using errcode = '22023';
    end if;
    v_ex_min := n::int;
  end if;
  if (v_ex_type is null) <> (v_ex_min is null) then
    raise exception 'invalid check-in payload: exercise needs both a type and minutes' using errcode = '22023';
  end if;
  if private.jt(p_checkin -> 'exercise_unit') not in ('string', 'null') then
    raise exception 'invalid check-in payload: exercise_unit must be text' using errcode = '22023';
  end if;
  v_unit := coalesce(nullif(p_checkin ->> 'exercise_unit', ''), 'minutes');
  if v_unit not in ('minutes', 'hours') then
    raise exception 'invalid check-in payload: exercise_unit must be minutes or hours' using errcode = '22023';
  end if;
  -- notes
  if private.jt(p_checkin -> 'notes') not in ('string', 'null') then
    raise exception 'invalid check-in payload: notes must be text' using errcode = '22023';
  end if;
  v_notes := coalesce(p_checkin ->> 'notes', '');
  if char_length(v_notes) > 4000 then
    raise exception 'invalid check-in payload: notes are too long (max 4000 characters)' using errcode = '22023';
  end if;
  -- meals
  meals := coalesce(p_checkin -> 'meals', '[]'::jsonb);
  if jsonb_typeof(meals) <> 'array' then
    raise exception 'invalid check-in payload: meals must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(meals) > 30 then
    raise exception 'invalid check-in payload: too many meals (max 30 per day)' using errcode = '22023';
  end if;
  for m, ord in select e, o from jsonb_array_elements(meals) with ordinality as t(e, o) loop
    if jsonb_typeof(m) <> 'object'
       or private.jt(m -> 'category') <> 'string' or (m ->> 'category') not in ('breakfast', 'lunch', 'dinner', 'snacks') then
      raise exception 'invalid check-in payload: meal category' using errcode = '22023';
    end if;
    if private.jt(m -> 'name') <> 'string' or char_length(m ->> 'name') not between 1 and 200 then
      raise exception 'invalid check-in payload: meal name must be 1-200 characters' using errcode = '22023';
    end if;
    if private.jt(m -> 'notes') not in ('string', 'null') or char_length(coalesce(m ->> 'notes', '')) > 1000 then
      raise exception 'invalid check-in payload: meal notes are too long (max 1000)' using errcode = '22023';
    end if;
    if private.jt(m -> 'eaten_at') <> 'string' or (m ->> 'eaten_at') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
      raise exception 'invalid check-in payload: meal time must be HH:MM' using errcode = '22023';
    end if;
    if private.jt(m -> 'position') not in ('number', 'null') then
      raise exception 'invalid check-in payload: meal position' using errcode = '22023';
    end if;
    if private.jt(m -> 'position') = 'number' then
      n := (m ->> 'position')::numeric;
      if n <> trunc(n) or n < 0 or n > 99 then
        raise exception 'invalid check-in payload: meal position' using errcode = '22023';
      end if;
    end if;
  end loop;

  wait := private.rate_check(uid, 'save_checkin', 30, interval '5 minutes', 400, interval '1 day');
  if wait > 0 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'retry_after', wait);
  end if;

  insert into public.checkins as c (user_id, checkin_date, mood, weight_kg, water_ml, exercise_type, exercise_minutes, exercise_unit, notes)
  values (uid, p_date, v_mood, v_weight, v_water, v_ex_type, v_ex_min, v_unit, v_notes)
  on conflict (user_id, checkin_date) do update set
    mood = excluded.mood, weight_kg = excluded.weight_kg, water_ml = excluded.water_ml,
    exercise_type = excluded.exercise_type, exercise_minutes = excluded.exercise_minutes,
    exercise_unit = excluded.exercise_unit, notes = excluded.notes
  returning c.id into cid;

  delete from public.checkin_meals cm where cm.checkin_id = cid and cm.user_id = uid;

  insert into public.checkin_meals (checkin_id, user_id, category, name, notes, eaten_at, position)
  select cid, uid, e ->> 'category', e ->> 'name', coalesce(e ->> 'notes', ''), (e ->> 'eaten_at')::time,
         coalesce((e ->> 'position')::int, o::int - 1)
  from jsonb_array_elements(meals) with ordinality as t(e, o);

  -- Achievements are evaluated when TODAY's check-in is saved (as the app always did); back-filling an old day does not.
  if p_date >= current_date - 1 then
    unlocked := private.grant_achievements(uid, p_date, array['first','d3','d7','d14','hydrated','active','consistent','goal']);
  end if;

  return jsonb_build_object('ok', true, 'id', cid, 'unlocked', unlocked);
end $$;

-- Creates the user's first journey (or edits the ACTIVE one) and marks them onboarded, atomically.
-- Start date: at most 30 days ahead, at most 10 years back. The database keeps exactly one active journey per user.
-- Journey integrity rules (they stop a journey being rewritten into an instant "achievement"):
--   1. A journey whose LAST day (start + duration - 1) is already in the past cannot be created or edited into existence.
--   2. Once the active journey has check-ins, it is history: its start date may not move earlier than its current start or
--      later than its first check-in, its starting weight cannot change, and its goal weight cannot be changed to a weight
--      an existing check-in has already reached (which would hand out "Goal Achieved" for free).
-- Before any check-in exists the journey may be edited freely (onboarding), within rule 1. Starting the NEXT journey is
-- start_next_journey and is unaffected by rule 2.
create or replace function public.create_journey(
  p_start date, p_duration int, p_start_weight numeric, p_goal_weight numeric, p_water_goal int
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  cur public.journeys%rowtype;
  first_ci date;
  has_cur boolean;
  wait int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not private.aal_ok() then
    raise exception 'mfa_required' using errcode = '28000';
  end if;
  if p_start is null or p_start > current_date + 30 or p_start < current_date - 3650 then
    raise exception 'invalid journey: start date is out of range' using errcode = '22007';
  end if;
  perform private.check_journey_params(p_duration, p_start_weight, p_goal_weight, p_water_goal);
  if p_start + (p_duration - 1) < current_date then
    raise exception 'invalid journey: it would already be over (its last day is in the past)' using errcode = '22007';
  end if;

  select * into cur from public.journeys jr where jr.user_id = uid and jr.completed_on is null for update;
  has_cur := found;
  if has_cur then
    select min(c.checkin_date) into first_ci from public.checkins c where c.user_id = uid and c.checkin_date >= cur.start_date;
    if first_ci is not null then -- the journey already has recorded history
      if p_start < cur.start_date or p_start > first_ci then
        raise exception 'invalid journey: the start date cannot move earlier, or past the first check-in' using errcode = '22007';
      end if;
      if round(p_start_weight, 1) <> cur.start_weight then
        raise exception 'invalid journey: the starting weight cannot change once check-ins exist' using errcode = '22023';
      end if;
      if round(p_goal_weight, 1) <> cur.goal_weight and exists (
        select 1 from public.checkins c
        where c.user_id = uid and c.checkin_date >= p_start and c.weight_kg is not null
          and ((p_goal_weight > cur.start_weight and c.weight_kg >= p_goal_weight)
            or (p_goal_weight < cur.start_weight and c.weight_kg <= p_goal_weight))
      ) then
        raise exception 'invalid journey: that goal is already reached by an existing check-in' using errcode = '22023';
      end if;
    end if;
  end if;

  wait := private.rate_check(uid, 'create_journey', 10, interval '1 hour', 30, interval '1 day');
  if wait > 0 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'retry_after', wait);
  end if;

  if has_cur then
    update public.journeys jr set
      start_date = p_start, duration_days = p_duration, start_weight = p_start_weight, goal_weight = p_goal_weight,
      water_goal_ml = p_water_goal, post_goal_mode = null, next_goal_weight = null
    where jr.id = cur.id;
  else
    insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml)
    values (uid, p_start, p_duration, p_start_weight, p_goal_weight, p_water_goal);
  end if;
  update public.profiles p set onboarded = true where p.id = uid;
  if not found then
    raise exception 'profile missing' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Archives the active journey (only once its last day has arrived) and starts the next one, atomically.
-- p_mode: 'continue' | 'new_goal' (a plain journey toward p_goal_weight) | 'maintain' | 'journal' (recorded on the journey).
create or replace function public.start_next_journey(
  p_start date, p_duration int, p_start_weight numeric, p_goal_weight numeric, p_water_goal int, p_mode text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  cur public.journeys%rowtype;
  last_day date;
  wait int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not private.aal_ok() then
    raise exception 'mfa_required' using errcode = '28000';
  end if;
  if p_mode is null or p_mode not in ('continue','new_goal','maintain','journal') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  perform private.check_journey_params(p_duration, p_start_weight, p_goal_weight, p_water_goal);
  select * into cur from public.journeys jr where jr.user_id = uid and jr.completed_on is null for update;
  if not found then
    raise exception 'no active journey' using errcode = 'P0002';
  end if;
  last_day := cur.start_date + (cur.duration_days - 1);
  -- current_date + 1 tolerates the gap between the server's UTC day and the user's local day.
  if last_day > current_date + 1 then
    raise exception 'journey is not complete yet' using errcode = '55000';
  end if;
  if p_start is null or p_start <= last_day then
    raise exception 'next journey must start after the previous one ends' using errcode = '22007';
  end if;
  if p_start > current_date + 30 then
    raise exception 'invalid journey: start date is out of range' using errcode = '22007';
  end if;
  if p_start + (p_duration - 1) < current_date then
    raise exception 'invalid journey: it would already be over (its last day is in the past)' using errcode = '22007';
  end if;
  wait := private.rate_check(uid, 'start_next_journey', 5, interval '1 hour', 10, interval '1 day');
  if wait > 0 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'retry_after', wait);
  end if;

  update public.journeys jr set completed_on = last_day where jr.id = cur.id;
  insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml, post_goal_mode)
  values (uid, p_start, p_duration, p_start_weight, p_goal_weight, p_water_goal,
          case when p_mode in ('maintain','journal') then p_mode else null end);
  return jsonb_build_object('ok', true);
end $$;

-- Changes the ACTIVE journey's daily water goal.
create or replace function public.update_water_goal(p_ml int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); wait int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not private.aal_ok() then
    raise exception 'mfa_required' using errcode = '28000';
  end if;
  if p_ml is null or p_ml not between 500 and 6000 then
    raise exception 'invalid water goal: violates the allowed range 500-6000 ml' using errcode = '22023';
  end if;
  wait := private.rate_check(uid, 'journey_edit', 20, interval '1 hour', 100, interval '1 day');
  if wait > 0 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'retry_after', wait);
  end if;
  update public.journeys jr set water_goal_ml = p_ml where jr.user_id = uid and jr.completed_on is null;
  if not found then
    raise exception 'no active journey' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Records what the user chose after achieving their goal. Only possible once the server has DERIVED the goal achievement
-- for the active journey; a client cannot claim it.
create or replace function public.set_post_goal(p_mode text, p_next numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); jr public.journeys%rowtype; wait int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not private.aal_ok() then
    raise exception 'mfa_required' using errcode = '28000';
  end if;
  if p_mode is null or p_mode not in ('new_goal', 'maintain', 'journal') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  if p_mode = 'new_goal' then
    if p_next is null or p_next not between 30 and 300 then
      raise exception 'invalid goal weight: violates the allowed range 30-300 kg' using errcode = '22023';
    end if;
  elsif p_next is not null then
    raise exception 'invalid goal weight: only a new goal carries a weight' using errcode = '22023';
  end if;
  select * into jr from public.journeys j where j.user_id = uid and j.completed_on is null;
  if not found then
    raise exception 'no active journey' using errcode = 'P0002';
  end if;
  if p_mode = 'new_goal' and p_next = jr.goal_weight then
    raise exception 'invalid goal weight: that is the goal already reached' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_achievements ua
                 where ua.user_id = uid and ua.achievement_id = 'goal' and ua.unlocked_on >= jr.start_date) then
    raise exception 'goal not reached' using errcode = '55000';
  end if;
  wait := private.rate_check(uid, 'journey_edit', 20, interval '1 hour', 100, interval '1 day');
  if wait > 0 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'retry_after', wait);
  end if;
  update public.journeys j set post_goal_mode = p_mode, next_goal_weight = case when p_mode = 'new_goal' then p_next end
  where j.id = jr.id;
  return jsonb_build_object('ok', true);
end $$;

-- Grants the "Journey Complete" achievement when the active journey's last day has arrived (the one achievement that is
-- not tied to saving a check-in). Derived server-side; the client supplies nothing.
create or replace function public.claim_journey_complete() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); wait int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not private.aal_ok() then
    raise exception 'mfa_required' using errcode = '28000';
  end if;
  wait := private.rate_check(uid, 'achievements', 20, interval '1 hour', 100, interval '1 day');
  if wait > 0 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'retry_after', wait);
  end if;
  -- current_date + 1: same time-zone slack as start_next_journey
  return jsonb_build_object('ok', true, 'unlocked', private.grant_achievements(uid, current_date + 1, array['journey']));
end $$;

revoke all on function public.save_checkin(date, jsonb)                                        from public, anon, authenticated;
revoke all on function public.create_journey(date, int, numeric, numeric, int)                 from public, anon, authenticated;
revoke all on function public.start_next_journey(date, int, numeric, numeric, int, text)       from public, anon, authenticated;
revoke all on function public.update_water_goal(int)                                           from public, anon, authenticated;
revoke all on function public.set_post_goal(text, numeric)                                     from public, anon, authenticated;
revoke all on function public.claim_journey_complete()                                         from public, anon, authenticated;
grant execute on function public.save_checkin(date, jsonb)                                     to authenticated;
grant execute on function public.create_journey(date, int, numeric, numeric, int)              to authenticated;
grant execute on function public.start_next_journey(date, int, numeric, numeric, int, text)    to authenticated;
grant execute on function public.update_water_goal(int)                                        to authenticated;
grant execute on function public.set_post_goal(text, numeric)                                  to authenticated;
grant execute on function public.claim_journey_complete()                                      to authenticated;

-- <<< SECURITY HARDENING

-- ---------- one-time legacy achievement cleanup (migration only) ----------
-- Before this migration a client could INSERT/UPDATE user_achievements directly, so existing rows are untrusted. A row is KEPT
-- when the user's own HISTORY supports it at (or shortly after) its unlocked_on date; only rows with no such evidence are moved
-- to private.achievements_quarantine (kept for review, restorable by an admin - never deleted outright).
-- Evidence is MONOTONIC: it only asks "did the data up to that date ever reach the bar?", never "does today's data still show
-- it?". So a finished journey's achievements, a goal reached before the weight moved again, a consistency streak that later
-- dropped, or a hydration streak before the water goal was raised are all preserved. The cutoff is unlocked_on + 1 day (the
-- same time-zone slack the RPCs use). Limits: if the very row that proved an old achievement has since been overwritten, or
-- the water goal at unlock time is unknown (hydrated is judged against the 500 ml minimum any goal can have), the evidence
-- is judged on what remains - which is why rows are quarantined rather than deleted.
create function private.kc_legacy_supported(p_uid uuid, p_aid text, p_on date) returns boolean
language plpgsql stable set search_path = '' as $$
declare cut date := p_on + 1; best int; j public.journeys%rowtype; t date; n int; inj int; dayidx int;
begin
  if p_aid = 'first' then
    return exists (select 1 from public.checkins c where c.user_id = p_uid and c.checkin_date <= cut);
  elsif p_aid in ('d3', 'd7', 'd14') then
    select coalesce(max(len), 0) into best from (
      select count(*) as len from (
        select c.checkin_date - (row_number() over (order by c.checkin_date))::int as g
        from public.checkins c where c.user_id = p_uid and c.checkin_date <= cut
      ) s group by s.g
    ) r;
    return best >= case p_aid when 'd3' then 3 when 'd7' then 7 else 14 end;
  elsif p_aid = 'hydrated' then
    return (select count(*) from public.checkins c where c.user_id = p_uid and c.checkin_date <= cut and c.water_ml >= 500) >= 7;
  elsif p_aid = 'active' then
    return (select count(*) from public.checkins c where c.user_id = p_uid and c.checkin_date <= cut and c.exercise_type is not null) >= 4
       and coalesce((select max(cnt) from (
             select (select count(*) from public.checkins c2
                     where c2.user_id = p_uid and c2.exercise_type is not null and c2.checkin_date <= cut
                       and c2.checkin_date >= c1.checkin_date and c2.checkin_date < c1.checkin_date + 7) as cnt
             from public.checkins c1 where c1.user_id = p_uid and c1.checkin_date <= cut) w), 0) >= 4;
  elsif p_aid = 'consistent' then
    -- some journey, on some check-in day up to the cutoff, had >= 7 check-ins in total and >= 80% of its days so far checked in
    for j in select * from public.journeys jj where jj.user_id = p_uid and jj.start_date <= cut loop
      for t in select distinct c.checkin_date from public.checkins c
               where c.user_id = p_uid and c.checkin_date >= j.start_date and c.checkin_date <= least(cut, coalesce(j.completed_on, cut))
      loop
        select count(*) into n   from public.checkins c where c.user_id = p_uid and c.checkin_date <= t;
        select count(*) into inj from public.checkins c where c.user_id = p_uid and c.checkin_date >= j.start_date and c.checkin_date <= t;
        dayidx := greatest(1, least(j.duration_days, (t - j.start_date) + 1));
        if n >= 7 and round(inj * 100.0 / dayidx) >= 80 then return true; end if;
      end loop;
    end loop;
    return false;
  elsif p_aid = 'goal' then
    -- a check-in inside some journey (its own window, not just the active one) reached that journey's goal weight
    return exists (
      select 1 from public.journeys jj join public.checkins c
        on c.user_id = jj.user_id and c.checkin_date >= jj.start_date and c.checkin_date <= least(cut, coalesce(jj.completed_on, cut))
      where jj.user_id = p_uid and c.weight_kg is not null
        and ((jj.goal_weight > jj.start_weight and c.weight_kg >= jj.goal_weight)
          or (jj.goal_weight < jj.start_weight and c.weight_kg <= jj.goal_weight)));
  elsif p_aid = 'journey' then
    -- the last day of some journey (finished or active) had arrived by the unlock date
    return exists (select 1 from public.journeys jj where jj.user_id = p_uid and jj.start_date + (jj.duration_days - 1) <= cut);
  end if;
  return false;
end $$;

do $$
declare moved int := 0;
begin
  if current_setting('kawther.legacy_cleanup', true) is distinct from 'true' then
    raise notice 'kawther: legacy achievement cleanup already done - skipped (nothing quarantined)';
  else
    with dead as (
      delete from public.user_achievements ua
      where not private.kc_legacy_supported(ua.user_id, ua.achievement_id, ua.unlocked_on)
      returning ua.user_id, ua.achievement_id, ua.unlocked_on
    ), q as (
      insert into private.achievements_quarantine (user_id, achievement_id, unlocked_on)
      select d.user_id, d.achievement_id, d.unlocked_on from dead d returning 1
    )
    select count(*) into moved from q;
    raise notice 'kawther: legacy achievement cleanup done - % unsupported row(s) quarantined', moved;
  end if;
  insert into private.schema_markers (name) values ('legacy_achievement_cleanup') on conflict do nothing;
end $$;
drop function private.kc_legacy_supported(uuid, text, date);

-- ---------- smoke test: the security functions must actually RUN here, not merely exist ----------
-- private.aal_ok() reads auth.mfa_factors as the role applying this migration. If that is not permitted on this project the
-- error is re-raised (never swallowed) and the whole migration rolls back; the function is not weakened to hide it.
do $$
declare ok boolean;
begin
  begin
    select private.aal_ok() into ok;
  exception when others then
    raise exception 'security hardening aborted: private.aal_ok() cannot execute for the migration role (%: %). It reads auth.mfa_factors, so this role needs SELECT on it. Nothing was applied.',
      sqlstate, sqlerrm using errcode = '42501';
  end;
  if ok is null then
    raise exception 'security hardening aborted: private.aal_ok() returned NULL (it must be true or false). Nothing was applied.' using errcode = '55000';
  end if;
  if not has_schema_privilege('authenticated', 'private', 'usage') or not has_function_privilege('authenticated', 'private.aal_ok()', 'execute') then
    raise exception 'security hardening aborted: authenticated cannot execute private.aal_ok(), so every RLS policy would fail. Nothing was applied.' using errcode = '42501';
  end if;
  if has_schema_privilege('anon', 'private', 'usage') or has_function_privilege('anon', 'private.aal_ok()', 'execute')
     or has_table_privilege('authenticated', 'private.achievements_quarantine', 'select') then
    raise exception 'security hardening aborted: the private schema is reachable by anon/authenticated. Nothing was applied.' using errcode = '42501';
  end if;
end $$;

commit;
