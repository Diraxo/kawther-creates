-- Goal Achievement: the 'goal' achievement, plus what the user chose to do after reaching their goal.
-- Run once in the Supabase SQL editor (after schema.sql / earlier migrations). Safe to re-run.

alter table public.journeys add column if not exists post_goal_mode text;
alter table public.journeys add column if not exists next_goal_weight numeric(5,1);
alter table public.journeys drop constraint if exists journeys_post_goal_mode_check;
alter table public.journeys add constraint journeys_post_goal_mode_check check (post_goal_mode in ('new_goal','maintain','journal'));
alter table public.journeys drop constraint if exists journeys_next_goal_weight_check;
alter table public.journeys add constraint journeys_next_goal_weight_check check (next_goal_weight between 30 and 300);
alter table public.journeys drop constraint if exists journeys_post_goal_consistent;
alter table public.journeys add constraint journeys_post_goal_consistent check ((post_goal_mode = 'new_goal') = (next_goal_weight is not null));

alter table public.user_achievements drop constraint if exists user_achievements_achievement_id_check;
alter table public.user_achievements add constraint user_achievements_achievement_id_check
  check (achievement_id in ('first','d3','d7','d14','hydrated','active','consistent','goal','journey'));
