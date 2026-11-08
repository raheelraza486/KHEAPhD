-- Enforce that only an administrator may mark an API as Verified
--
-- DO NOT APPLY THIS UNTIL SIGN-IN EXISTS.
--
-- It lives in migrations/pending/ rather than migrations/ on purpose:
-- scripts/migrate.sh globs migrations/*.sql and does not recurse, so nothing
-- here is ever applied by accident. A comment alone would not have stopped it.
--
-- When the three conditions below are met, move it into migrations/ and give it
-- the next free number at that time -- not now, or it would sort ahead of
-- migrations written in the meantime.
--
-- Split out of 0003_access_control.sql. 0003 creates the identities -- the
-- app_user table, the role predicates, the verified_by_user column -- and
-- changes no existing behaviour, so it can be applied straight away. This file
-- is the half that changes behaviour, and it is only safe once a signed-in
-- session reaches the database.
--
-- Why the split
-- -------------
-- A trigger fires regardless of privilege. Unlike row-level security, the
-- Supabase service key does not bypass it. With no sign-in, there is no JWT for
-- auth.uid() to read, so is_admin() returns false for every caller including
-- the API route handler. Applying this before sign-in exists therefore refuses
-- every attempt to set review_status to 'Verified', by anyone, through any
-- path.
--
-- Verified against Postgres 16 with 0000 to 0003 applied:
--
--   -- ordinary connection
--   update public.apis set review_status='Verified' where api_name='...';
--   ERROR:  Only an administrator may mark an API as Verified
--
--   -- as the database owner
--   set role <owner>;
--   update public.apis set review_status='Verified' where api_name='...';
--   ERROR:  Only an administrator may mark an API as Verified
--
-- Manual verification is Section C's whole task, so applying this early would
-- stop that work outright.
--
-- Before applying, check all three
-- -------------------------------
--   1. Sign-in exists and the API route forwards the caller's session to
--      Supabase, so that auth.uid() resolves to a real user.
--   2. At least one row in public.app_user has role = 'admin' and
--      is_active = true, and the person holding that account knows they hold it.
--   3. Whoever is doing manual verification signs in as that account, or has
--      their own admin row.
--
-- A quick way to confirm 2 before running this:
--
--   select email, role from public.app_user where role = 'admin' and is_active;

create or replace function public.guard_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.review_status = 'Verified'
     and (tg_op = 'INSERT' or old.review_status is distinct from 'Verified') then
    if not public.is_admin() then
      raise exception 'Only an administrator may mark an API as Verified'
        using errcode = '42501';
    end if;
    new.verified_by_user = coalesce(new.verified_by_user, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists guard_apis_verification on public.apis;
create trigger guard_apis_verification
before insert or update of review_status on public.apis
for each row execute function public.guard_verification();
