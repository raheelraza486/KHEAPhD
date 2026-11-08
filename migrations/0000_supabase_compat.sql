-- Supabase compatibility shim for the local environment
-- Pod A · CS9-5
--
-- The deployed database is Supabase, which creates the roles `anon`,
-- `authenticated` and `service_role`, and an `auth` schema whose `auth.uid()`
-- returns the signed-in user. Plain Postgres has none of them, so the schema we
-- run in production stops with `role "anon" does not exist` when run locally,
-- leaving the audit table and every policy uncreated.
--
-- This creates just enough of that surface for the same SQL to run in both
-- places. On Supabase every statement here is a no-op, because each object
-- already exists and each block checks first.
--
-- It creates no passwords and grants no login. These are group roles used only
-- so that GRANT, REVOKE and POLICY statements resolve.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;

-- auth.uid() on Supabase reads the JWT claim the connection was opened with.
-- Locally there is no JWT, so it reads a session setting instead, which lets a
-- test set who it is pretending to be:
--
--   set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
--
-- Created only if absent, so Supabase's own definition always wins.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid
      language sql stable
      as $body$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $body$;
    $fn$;
  end if;
end
$$;

-- auth.users is referenced by app_user. Supabase owns the real table; locally a
-- minimal stand-in is enough for the foreign key to resolve.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'auth' and table_name = 'users'
  ) then
    create table auth.users (
      id    uuid primary key default gen_random_uuid(),
      email text unique
    );
  end if;
end
$$;
