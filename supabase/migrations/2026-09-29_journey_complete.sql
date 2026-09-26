-- Journey Complete: a finished journey becomes permanent history and "what's next" starts a NEW journey.
-- Run once in the Supabase SQL editor (after schema.sql / earlier migrations). Safe to re-run.
--   * journeys: one row per journey. `completed_on` is set (once) when the next journey starts and is never edited after.
--     Exactly one row per user is active (completed_on is null), enforced by a partial unique index.
--   * user_achievements accepts the new 'journey' achievement.
--   * create_journey (onboarding) now updates the ACTIVE journey only; start_next_journey archives it and starts the next.

alter table public.journeys drop constraint if exists journeys_user_id_key;
alter table public.journeys add column if not exists completed_on date;
create unique index if not exists journeys_one_active_per_user on public.journeys (user_id) where completed_on is null;
create index if not exists journeys_user_start_idx on public.journeys (user_id, start_date);

alter table public.user_achievements drop constraint if exists user_achievements_achievement_id_check;
alter table public.user_achievements add constraint user_achievements_achievement_id_check
  check (achievement_id in ('first','d3','d7','d14','hydrated','active','consistent','goal','journey'));

-- Completed journeys are immutable: no update policy path may touch them.
drop policy if exists "journeys update" on public.journeys;
create policy "journeys update" on public.journeys for update to authenticated
  using (user_id = auth.uid() and completed_on is null) with check (user_id = auth.uid());

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

revoke all on function public.start_next_journey(date, int, numeric, numeric, int, text) from public, anon;
grant execute on function public.start_next_journey(date, int, numeric, numeric, int, text) to authenticated;
