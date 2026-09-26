-- Kawther | creates — Supabase schema (tables, constraints, RLS, RPCs).
-- Run the WHOLE file in the Supabase SQL editor on a fresh project (it is re-runnable).
-- Passwords are NEVER stored here: Supabase Auth owns credentials (auth.users).

-- ---------- tables ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '' check (char_length(full_name) <= 120),
  email       text not null default '',
  onboarded   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- One row per journey. Exactly one is active per user (completed_on is null); completed journeys are immutable history.
create table if not exists public.journeys (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  start_date     date not null,
  duration_days  int  not null check (duration_days between 7 and 365),
  start_weight   numeric(5,1) not null check (start_weight between 30 and 300),
  goal_weight    numeric(5,1) not null check (goal_weight  between 30 and 300),
  water_goal_ml  int  not null default 2500 check (water_goal_ml between 500 and 6000),
  -- What she chose after achieving the original goal (the journey itself is never ended or replaced).
  post_goal_mode text check (post_goal_mode in ('new_goal','maintain','journal')),
  next_goal_weight numeric(5,1) check (next_goal_weight between 30 and 300),
  check ((post_goal_mode = 'new_goal') = (next_goal_weight is not null)),
  completed_on   date,
  created_at     timestamptz not null default now()
);
create unique index if not exists journeys_one_active_per_user on public.journeys (user_id) where completed_on is null;
create index if not exists journeys_user_start_idx on public.journeys (user_id, start_date);

create table if not exists public.checkins (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  checkin_date      date not null,
  mood              text check (mood in ('great','good','okay','tired','low')),
  weight_kg         numeric(5,1) check (weight_kg between 30 and 300),
  water_ml          int  not null default 0 check (water_ml between 0 and 20000),
  exercise_type     text check (char_length(exercise_type) <= 60),
  exercise_minutes  int  check (exercise_minutes between 0 and 1440),
  -- the unit the user entered the duration in; minutes are the canonical stored value, the unit is how it is shown back
  exercise_unit     text not null default 'minutes' check (exercise_unit in ('minutes','hours')),
  notes             text not null default '' check (char_length(notes) <= 4000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, checkin_date),
  -- lets checkin_meals prove a meal's owner == its check-in's owner (see composite FK below)
  unique (id, user_id),
  check ((exercise_type is null) = (exercise_minutes is null))
);

create table if not exists public.checkin_meals (
  id          uuid primary key default gen_random_uuid(),
  checkin_id  uuid not null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  category    text not null check (category in ('breakfast','lunch','dinner','snacks')),
  name        text not null check (char_length(name) between 1 and 200),
  notes       text not null default '' check (char_length(notes) <= 1000),
  eaten_at    time not null,
  position    int  not null default 0,
  -- IDOR guard: a meal can only hang off a check-in owned by the SAME user.
  -- (RLS alone checks user_id; without this a user could point checkin_id at someone else's check-in.)
  foreign key (checkin_id, user_id) references public.checkins (id, user_id) on delete cascade
);
create index if not exists checkin_meals_checkin_idx on public.checkin_meals (checkin_id);
create index if not exists checkin_meals_user_idx    on public.checkin_meals (user_id);

-- Achievement *definitions* live in the app (src/domain/achievements.js);
-- only unlocks are stored.
create table if not exists public.user_achievements (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  achievement_id  text not null check (achievement_id in ('first','d3','d7','d14','hydrated','active','consistent','goal','journey')),
  unlocked_on     date not null,
  primary key (user_id, achievement_id)
);

-- ---------- housekeeping ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists checkins_touch on public.checkins;
create trigger checkins_touch before update on public.checkins
  for each row execute function public.touch_updated_at();

-- Create the profile row whenever an auth user is created (works with email confirmation on).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120), coalesce(new.email, ''));
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- privileges: least privilege, then RLS on top ----------
-- Supabase grants ALL on new public tables to anon/authenticated by default; take that away.
revoke all on public.profiles, public.journeys, public.checkins, public.checkin_meals, public.user_achievements
  from anon, authenticated;

grant select                       on public.profiles          to authenticated;
grant update (full_name, onboarded) on public.profiles         to authenticated;  -- email/id are not client-editable
grant select, insert, update       on public.journeys          to authenticated;
grant select, insert, update       on public.checkins          to authenticated;
grant select, insert, update, delete on public.checkin_meals   to authenticated;  -- delete: replace a day's meals
grant select, insert, update       on public.user_achievements to authenticated;
-- profiles are inserted only by the auth trigger; nothing is deletable except meals (no account/journey delete in the app).

-- ---------- row level security: users only ever touch their own rows ----------
alter table public.profiles          enable row level security;
alter table public.journeys          enable row level security;
alter table public.checkins          enable row level security;
alter table public.checkin_meals     enable row level security;
alter table public.user_achievements enable row level security;

-- Drop every previous policy name (this file was re-run during development).
drop policy if exists "own profile"      on public.profiles;
drop policy if exists "own journeys"     on public.journeys;
drop policy if exists "own checkins"     on public.checkins;
drop policy if exists "own meals"        on public.checkin_meals;
drop policy if exists "own achievements" on public.user_achievements;
drop policy if exists "profiles select"  on public.profiles;
drop policy if exists "profiles update"  on public.profiles;
drop policy if exists "journeys select"  on public.journeys;
drop policy if exists "journeys insert"  on public.journeys;
drop policy if exists "journeys update"  on public.journeys;
drop policy if exists "checkins select"  on public.checkins;
drop policy if exists "checkins insert"  on public.checkins;
drop policy if exists "checkins update"  on public.checkins;
drop policy if exists "meals select"     on public.checkin_meals;
drop policy if exists "meals insert"     on public.checkin_meals;
drop policy if exists "meals update"     on public.checkin_meals;
drop policy if exists "meals delete"     on public.checkin_meals;
drop policy if exists "ach select"       on public.user_achievements;
drop policy if exists "ach insert"       on public.user_achievements;
drop policy if exists "ach update"       on public.user_achievements;

create policy "profiles select" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "journeys select" on public.journeys for select to authenticated using (user_id = auth.uid());
create policy "journeys insert" on public.journeys for insert to authenticated with check (user_id = auth.uid());
create policy "journeys update" on public.journeys for update to authenticated using (user_id = auth.uid() and completed_on is null) with check (user_id = auth.uid());

create policy "checkins select" on public.checkins for select to authenticated using (user_id = auth.uid());
create policy "checkins insert" on public.checkins for insert to authenticated with check (user_id = auth.uid());
create policy "checkins update" on public.checkins for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "meals select" on public.checkin_meals for select to authenticated using (user_id = auth.uid());
create policy "meals insert" on public.checkin_meals for insert to authenticated with check (user_id = auth.uid());
create policy "meals update" on public.checkin_meals for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "meals delete" on public.checkin_meals for delete to authenticated using (user_id = auth.uid());

create policy "ach select" on public.user_achievements for select to authenticated using (user_id = auth.uid());
create policy "ach insert" on public.user_achievements for insert to authenticated with check (user_id = auth.uid());
create policy "ach update" on public.user_achievements for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- atomic RPCs ----------
-- All are SECURITY INVOKER: they run as the calling user, so RLS and the grants above still
-- apply to every statement. Nothing here bypasses or weakens them. Each function is one
-- transaction: any error rolls the whole call back.

-- Upserts the day's check-in and replaces its meals, atomically.
-- p_checkin: { mood, weight_kg, water_ml, exercise_type, exercise_minutes, exercise_unit, notes,
--              meals: [{ category, name, notes, eaten_at, position }] }
create or replace function public.save_checkin(p_date date, p_checkin jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  meals jsonb := coalesce(p_checkin->'meals', '[]'::jsonb);
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_date is null or p_date > current_date + 1 then
    raise exception 'invalid check-in date' using errcode = '22007';
  end if;
  if p_checkin is null or jsonb_typeof(meals) <> 'array' or jsonb_array_length(meals) > 40 then
    raise exception 'invalid check-in payload' using errcode = '22023';
  end if;

  insert into public.checkins as c (user_id, checkin_date, mood, weight_kg, water_ml, exercise_type, exercise_minutes, exercise_unit, notes)
  values (
    uid, p_date,
    nullif(p_checkin->>'mood', ''),
    (p_checkin->>'weight_kg')::numeric,
    coalesce((p_checkin->>'water_ml')::int, 0),
    nullif(p_checkin->>'exercise_type', ''),
    (p_checkin->>'exercise_minutes')::int,
    coalesce(nullif(p_checkin->>'exercise_unit', ''), 'minutes'),
    coalesce(p_checkin->>'notes', '')
  )
  on conflict (user_id, checkin_date) do update set
    mood = excluded.mood, weight_kg = excluded.weight_kg, water_ml = excluded.water_ml,
    exercise_type = excluded.exercise_type, exercise_minutes = excluded.exercise_minutes,
    exercise_unit = excluded.exercise_unit, notes = excluded.notes
  returning c.id into cid;

  delete from public.checkin_meals where checkin_id = cid and user_id = uid;

  insert into public.checkin_meals (checkin_id, user_id, category, name, notes, eaten_at, position)
  select cid, uid, m->>'category', m->>'name', coalesce(m->>'notes', ''), (m->>'eaten_at')::time,
         coalesce((m->>'position')::int, ord::int - 1)
  from jsonb_array_elements(meals) with ordinality as t(m, ord);

  return cid;
end $$;

-- Creates the user's first journey (or updates the ACTIVE one) and marks them onboarded, atomically.
create or replace function public.create_journey(
  p_start date, p_duration int, p_start_weight numeric, p_goal_weight numeric, p_water_goal int
) returns void
language plpgsql security invoker set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.journeys set
    start_date = p_start, duration_days = p_duration, start_weight = p_start_weight, goal_weight = p_goal_weight,
    water_goal_ml = p_water_goal, post_goal_mode = null, next_goal_weight = null
  where user_id = uid and completed_on is null;
  if not found then
    insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml)
    values (uid, p_start, p_duration, p_start_weight, p_goal_weight, p_water_goal);
  end if;
  update public.profiles set onboarded = true where id = uid;
  if not found then
    raise exception 'profile missing' using errcode = 'P0002';
  end if;
end $$;

-- Archives the active journey (only once its last day has arrived) and starts the next one, atomically.
-- p_mode: 'continue' | 'new_goal' (a plain journey toward p_goal_weight) | 'maintain' | 'journal' (recorded on the journey).
create or replace function public.start_next_journey(
  p_start date, p_duration int, p_start_weight numeric, p_goal_weight numeric, p_water_goal int, p_mode text
) returns void
language plpgsql security invoker set search_path = public as $$
declare
  uid uuid := auth.uid();
  cur public.journeys;
  last_day date;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_mode not in ('continue','new_goal','maintain','journal') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  select * into cur from public.journeys where user_id = uid and completed_on is null for update;
  if not found then
    raise exception 'no active journey' using errcode = 'P0002';
  end if;
  last_day := cur.start_date + (cur.duration_days - 1);
  -- current_date + 1 tolerates the gap between the server's UTC day and the user's local day.
  if last_day > current_date + 1 then
    raise exception 'journey is not complete yet' using errcode = '55000';
  end if;
  if p_start <= last_day then
    raise exception 'next journey must start after the previous one ends' using errcode = '22007';
  end if;
  update public.journeys set completed_on = last_day where id = cur.id;
  insert into public.journeys (user_id, start_date, duration_days, start_weight, goal_weight, water_goal_ml, post_goal_mode)
  values (uid, p_start, p_duration, p_start_weight, p_goal_weight, p_water_goal,
          case when p_mode in ('maintain','journal') then p_mode else null end);
end $$;

revoke all on function public.save_checkin(date, jsonb)                        from public, anon;
revoke all on function public.create_journey(date, int, numeric, numeric, int) from public, anon;
grant execute on function public.save_checkin(date, jsonb)                        to authenticated;
grant execute on function public.create_journey(date, int, numeric, numeric, int) to authenticated;
revoke all on function public.start_next_journey(date, int, numeric, numeric, int, text) from public, anon;
grant execute on function public.start_next_journey(date, int, numeric, numeric, int, text) to authenticated;
