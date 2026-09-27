-- Security hardening - OPTIONAL auth audit triggers (2026-09-30b). Apply AFTER 2026-09-30_security_hardening.sql.
-- Installs triggers on the Supabase-owned tables auth.users, auth.sessions and auth.mfa_factors so that login, password
-- change, reset request, MFA on/off and session revocation land in public.security_events.
-- This file is OPTIONAL: none of the core protections (RLS, grants, RPCs, achievement protection, rate limits, MFA/AAL2
-- enforcement) depend on it, and skipping or failing it does not weaken them - you only lose those audit events.
-- Failure behaviour: it runs in its own transaction; a trigger that cannot be installed raises a WARNING naming the table and
-- the others are still attempted. Re-running is safe (each trigger is dropped and recreated).

begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('private.log_security_event(uuid, text, jsonb, interval)') is null then
    raise exception 'apply 2026-09-30_security_hardening.sql first (private.log_security_event is missing)' using errcode = '55000';
  end if;
end $$;

-- >>> AUTH AUDIT TRIGGERS (OPTIONAL; kept byte-identical in schema.sql and supabase/migrations/2026-09-30b_auth_audit_triggers.sql; tests enforce it)
--
-- Security-event triggers on Supabase-owned auth tables (auth.users, auth.sessions, auth.mfa_factors). They only feed the
-- security_events audit trail (login / password change / reset request / MFA on-off / session revoked). Nothing in the core
-- hardening (RLS, grants, RPCs, achievement protection, rate limits, MFA enforcement) depends on them, so they live apart
-- and their installation can fail without weakening anything. Failure behaviour is explicit: each trigger is installed on
-- its own, a refusal raises a WARNING naming the table, and the remaining triggers are still attempted.
-- Every trigger body swallows its own errors: auditing must never be able to break sign-in, sign-out or MFA.
create or replace function private.on_auth_user_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.last_sign_in_at is not null and new.last_sign_in_at is distinct from old.last_sign_in_at then
      perform private.log_security_event(new.id, 'login');
    end if;
    if new.encrypted_password is distinct from old.encrypted_password then
      perform private.log_security_event(new.id, 'password_change');
    end if;
    if new.recovery_sent_at is not null and new.recovery_sent_at is distinct from old.recovery_sent_at then
      perform private.log_security_event(new.id, 'password_reset_request');
    end if;
  exception when others then null;
  end;
  return new;
end $$;

create or replace function private.on_auth_mfa_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if tg_op = 'DELETE' then
      if old.status = 'verified' then perform private.log_security_event(old.user_id, 'mfa_disabled'); end if;
    elsif new.status = 'verified' and (tg_op = 'INSERT' or old.status is distinct from 'verified') then
      perform private.log_security_event(new.user_id, 'mfa_enabled');
    end if;
  exception when others then null;
  end;
  return coalesce(new, old);
end $$;

create or replace function private.on_auth_session_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin -- one event per burst (a global sign-out deletes several rows); skipped when the whole account is being deleted
    if exists (select 1 from auth.users u where u.id = old.user_id) then
      perform private.log_security_event(old.user_id, 'session_revoked', '{}'::jsonb, interval '1 minute');
    end if;
  exception when others then null;
  end;
  return old;
end $$;

revoke all on function private.on_auth_user_update()     from public, anon, authenticated;
revoke all on function private.on_auth_mfa_change()      from public, anon, authenticated;
revoke all on function private.on_auth_session_delete()  from public, anon, authenticated;

do $$
begin
  if to_regclass('auth.users') is null then raise exception 'no auth.users'; end if;
  drop trigger if exists kc_auth_user_update on auth.users;
  create trigger kc_auth_user_update after update on auth.users for each row execute function private.on_auth_user_update();
exception when others then raise warning 'kawther: audit trigger on auth.users NOT installed (login/password events will not be recorded): %', sqlerrm;
end $$;
do $$
begin
  if to_regclass('auth.mfa_factors') is null then raise exception 'no auth.mfa_factors'; end if;
  drop trigger if exists kc_auth_mfa_change on auth.mfa_factors;
  create trigger kc_auth_mfa_change after insert or update or delete on auth.mfa_factors for each row execute function private.on_auth_mfa_change();
exception when others then raise warning 'kawther: audit trigger on auth.mfa_factors NOT installed (MFA events will not be recorded): %', sqlerrm;
end $$;
do $$
begin
  if to_regclass('auth.sessions') is null then raise exception 'no auth.sessions'; end if;
  drop trigger if exists kc_auth_session_delete on auth.sessions;
  create trigger kc_auth_session_delete after delete on auth.sessions for each row execute function private.on_auth_session_delete();
exception when others then raise warning 'kawther: audit trigger on auth.sessions NOT installed (session events will not be recorded): %', sqlerrm;
end $$;
-- <<< AUTH AUDIT TRIGGERS

commit;
