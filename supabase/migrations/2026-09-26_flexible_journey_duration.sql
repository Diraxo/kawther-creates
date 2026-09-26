-- Custom journey lengths: allow any whole number of days from 7 to 365 (was 30/60/90 only).
-- Run once in the Supabase SQL editor. Safe to re-run.
alter table public.journeys drop constraint if exists journeys_duration_days_check;
alter table public.journeys add constraint journeys_duration_days_check
  check (duration_days between 7 and 365);
