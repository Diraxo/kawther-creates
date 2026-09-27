-- Movement journal (2026-10-01): optional duration + type-specific details (muscle groups / distance / steps / description)
-- on the day's check-in. Apply ONCE, AFTER schema.sql's security hardening (2026-09-30_security_hardening.sql): it replaces
-- save_checkin, which relies on the hardening's private.* helpers. It is independent of the hardening file (never combined).
-- Backward compatible: every existing check-in keeps working ("details not recorded"). Safe to re-run.
-- NOT applied automatically to any hosted project: run it yourself, as ONE execution, when you are ready.

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regnamespace('private') is null or to_regprocedure('private.aal_ok()') is null then
    raise exception 'apply the security hardening (2026-09-30_security_hardening.sql) first: this migration replaces save_checkin';
  end if;
  if to_regclass('public.checkins') is null then raise exception 'public.checkins is missing'; end if;
end $$;

-- >>> MOVEMENT JOURNAL (kept byte-identical in schema.sql and supabase/migrations/2026-10-01_movement_journal.sql; tests enforce it)
-- A day's movement is ONE authoritative state on its checkins row (no child rows, so an edit can never duplicate it):
--   exercise_type          NULL = rest day; otherwise Gym | Running | Walking | Home workout | Other
--   exercise_minutes       optional duration in whole minutes (NULL = "not recorded"); exercise_unit is legacy display metadata
--   exercise_muscles       Gym only        - muscle groups trained (max 12)
--   exercise_distance_mi   Running only    - miles, optional
--   exercise_steps         Walking only    - whole steps, optional
--   exercise_description   Home workout / Other only - short free text, optional
-- Existing rows keep working: the new columns default to "not recorded". Ownership / RLS are untouched: writes still only go
-- through save_checkin (SECURITY DEFINER, auth.uid()), reads through the existing owner-only policies.
alter table public.checkins add column if not exists exercise_muscles text[] not null default '{}'
  check (cardinality(exercise_muscles) <= 12 and char_length(array_to_string(exercise_muscles, '|')) <= 600);
alter table public.checkins add column if not exists exercise_distance_mi numeric(6,2) check (exercise_distance_mi between 0 and 1000);
alter table public.checkins add column if not exists exercise_steps int check (exercise_steps between 0 and 200000);
alter table public.checkins add column if not exists exercise_description text not null default '' check (char_length(exercise_description) <= 500);

-- The old rule "type and minutes are both set or both empty" made the duration mandatory; it becomes "minutes need a type".
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.checkins'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%(exercise_type IS NULL) = (exercise_minutes IS NULL)%' loop
    execute format('alter table public.checkins drop constraint %I', c);
  end loop;
end $$;
alter table public.checkins drop constraint if exists checkins_exercise_minutes_need_type;
alter table public.checkins add constraint checkins_exercise_minutes_need_type check (exercise_type is not null or exercise_minutes is null);
alter table public.checkins drop constraint if exists checkins_exercise_details_match_type;
alter table public.checkins add constraint checkins_exercise_details_match_type check (
  (exercise_type is not null
     or (cardinality(exercise_muscles) = 0 and exercise_distance_mi is null and exercise_steps is null and exercise_description = ''))
  and (exercise_type = 'Gym' or cardinality(exercise_muscles) = 0)
  and (exercise_type = 'Running' or exercise_distance_mi is null)
  and (exercise_type = 'Walking' or exercise_steps is null)
  and (exercise_type in ('Home workout', 'Other') or exercise_description = '')
);

-- save_checkin: the same function as before (auth, MFA, rate limit, validation, atomic upsert + achievements), now with the
-- optional movement details. The duration is optional; details that do not belong to the chosen type are dropped.
-- p_checkin: { mood, weight_kg, water_ml, exercise_type, exercise_minutes, exercise_unit, exercise_muscles[], exercise_distance_mi,
--              exercise_steps, exercise_description, notes, meals: [{ category, name, notes, eaten_at, position }] }
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
  v_muscles text[] := '{}'; v_dist numeric; v_steps int; v_desc text := ''; mj jsonb;
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
  -- exercise (one movement per day: a type; the duration and the type-specific details are all optional)
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
  if v_ex_type is null and v_ex_min is not null then
    raise exception 'invalid check-in payload: exercise minutes need an exercise type' using errcode = '22023';
  end if;
  if private.jt(p_checkin -> 'exercise_unit') not in ('string', 'null') then
    raise exception 'invalid check-in payload: exercise_unit must be text' using errcode = '22023';
  end if;
  v_unit := coalesce(nullif(p_checkin ->> 'exercise_unit', ''), 'minutes');
  if v_unit not in ('minutes', 'hours') then
    raise exception 'invalid check-in payload: exercise_unit must be minutes or hours' using errcode = '22023';
  end if;
  -- movement details: optional, and only the ones that belong to the movement type are kept (Gym: muscle groups,
  -- Running: distance in miles, Walking: steps, Home workout / Other: a short description). Anything else is dropped.
  if private.jt(p_checkin -> 'exercise_muscles') not in ('array', 'null')
     or private.jt(p_checkin -> 'exercise_distance_mi') not in ('number', 'null')
     or private.jt(p_checkin -> 'exercise_steps') not in ('number', 'null')
     or private.jt(p_checkin -> 'exercise_description') not in ('string', 'null') then
    raise exception 'invalid check-in payload: movement details have the wrong type' using errcode = '22023';
  end if;
  if private.jt(p_checkin -> 'exercise_muscles') = 'array' then
    if jsonb_array_length(p_checkin -> 'exercise_muscles') > 12 then
      raise exception 'invalid check-in payload: too many muscle groups (max 12)' using errcode = '22023';
    end if;
    for mj in select e from jsonb_array_elements(p_checkin -> 'exercise_muscles') as t(e) loop
      if jsonb_typeof(mj) <> 'string' or char_length(btrim(mj #>> '{}')) not between 1 and 40 then
        raise exception 'invalid check-in payload: each muscle group must be 1-40 characters' using errcode = '22023';
      end if;
      if not (btrim(mj #>> '{}') = any (v_muscles)) then v_muscles := v_muscles || btrim(mj #>> '{}'); end if;
    end loop;
  end if;
  if private.jt(p_checkin -> 'exercise_distance_mi') = 'number' then
    n := (p_checkin ->> 'exercise_distance_mi')::numeric;
    if n < 0 or n > 1000 or n <> round(n, 2) then
      raise exception 'invalid check-in payload: exercise_distance_mi violates the allowed range 0-1000 (2 decimals)' using errcode = '22023';
    end if;
    v_dist := n;
  end if;
  if private.jt(p_checkin -> 'exercise_steps') = 'number' then
    n := (p_checkin ->> 'exercise_steps')::numeric;
    if n <> trunc(n) or n < 0 or n > 200000 then
      raise exception 'invalid check-in payload: exercise_steps violates the allowed range 0-200000' using errcode = '22023';
    end if;
    v_steps := n::int;
  end if;
  if private.jt(p_checkin -> 'exercise_description') = 'string' then
    v_desc := btrim(p_checkin ->> 'exercise_description');
    if char_length(v_desc) > 500 then
      raise exception 'invalid check-in payload: exercise_description is too long (max 500 characters)' using errcode = '22023';
    end if;
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

  if v_ex_type is distinct from 'Gym' then v_muscles := '{}'; end if;
  if v_ex_type is distinct from 'Running' then v_dist := null; end if;
  if v_ex_type is distinct from 'Walking' then v_steps := null; end if;
  if v_ex_type is null or v_ex_type not in ('Home workout', 'Other') then v_desc := ''; end if;

  wait := private.rate_check(uid, 'save_checkin', 30, interval '5 minutes', 400, interval '1 day');
  if wait > 0 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'retry_after', wait);
  end if;

  insert into public.checkins as c (user_id, checkin_date, mood, weight_kg, water_ml, exercise_type, exercise_minutes, exercise_unit,
    exercise_muscles, exercise_distance_mi, exercise_steps, exercise_description, notes)
  values (uid, p_date, v_mood, v_weight, v_water, v_ex_type, v_ex_min, v_unit, v_muscles, v_dist, v_steps, v_desc, v_notes)
  on conflict (user_id, checkin_date) do update set
    mood = excluded.mood, weight_kg = excluded.weight_kg, water_ml = excluded.water_ml,
    exercise_type = excluded.exercise_type, exercise_minutes = excluded.exercise_minutes,
    exercise_unit = excluded.exercise_unit, exercise_muscles = excluded.exercise_muscles,
    exercise_distance_mi = excluded.exercise_distance_mi, exercise_steps = excluded.exercise_steps,
    exercise_description = excluded.exercise_description, notes = excluded.notes
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
-- <<< MOVEMENT JOURNAL

commit;
