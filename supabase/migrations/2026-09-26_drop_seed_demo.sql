-- Real-user release: remove the demo seeder from an already-provisioned project.
-- Run once in the Supabase SQL editor. Safe to re-run.
drop function if exists public.seed_demo(jsonb, jsonb, jsonb);
-- Optional: delete the old shared demo user + its data (Auth -> Users -> demo@kawthercreates.com -> Delete).
-- Cascades remove its profile, journey, check-ins, meals and achievements.
