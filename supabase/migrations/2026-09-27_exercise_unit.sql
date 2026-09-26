-- Movement duration unit: keep how the user entered it ("1 hr" vs "60 min"). Minutes stay the canonical value.
-- Run once in the Supabase SQL editor (after schema.sql / earlier migrations). Safe to re-run.
alter table public.checkins add column if not exists exercise_unit text not null default 'minutes';
alter table public.checkins drop constraint if exists checkins_exercise_unit_check;
alter table public.checkins add constraint checkins_exercise_unit_check check (exercise_unit in ('minutes','hours'));

-- Replace save_checkin so it stores the unit (same signature, same security model: SECURITY INVOKER + RLS).
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
