-- Repository access control
-- Pod A · CS9-5 · drafted 29 August 2026
--
-- Why this exists
-- ---------------
-- At the client meeting on 29 August the client asked for a single human
-- administrator who approves records, said AI may assist in flagging suspect
-- entries, and asked to be added as a user once access control is designed.
--
-- Today the four mutating routes (POST, PUT, PATCH, DELETE) are protected only
-- by an Origin/Host check and a rate limit. That stops another website driving a
-- visitor's browser, but it does not stop a direct request that sets a matching
-- Origin header. The route holds the Supabase secret key, so those requests
-- bypass row-level security entirely, and `actor_name` in the audit trail is
-- whatever the caller typed.
--
-- This migration adds the identities only: the app_user table, the role
-- predicates, and a column recording which account verified a record. Nothing
-- here changes the behaviour of any existing request, so it is safe to apply
-- before sign-in exists.
--
-- Enforcement is split out into 0006_enforce_verification_admin.sql, which must
-- wait for sign-in. See the note at the foot of this file.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- app_user
-- One row per person allowed to sign in. Supabase Auth owns the credentials;
-- this table owns what they are allowed to do. The link is by auth user id, so
-- no password or email verification logic lives here.

create table if not exists public.app_user (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  display_name  text not null default '',
  role          text not null default 'viewer'
                check (role in ('viewer', 'publisher', 'admin')),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.app_user is
  'People who may sign in, and what each may do. Credentials live in auth.users.';

comment on column public.app_user.role is
  'viewer   — read the catalogue only.
   publisher — submit an API and edit their own submissions; cannot verify.
   admin    — verify, change review status, deactivate and restore any record.
              The client asked for a single human administrator in this role.';

create unique index if not exists app_user_email_unique
  on public.app_user (lower(email));

create index if not exists app_user_role_idx
  on public.app_user (role) where is_active;

drop trigger if exists set_app_user_updated_at on public.app_user;
create trigger set_app_user_updated_at
before update on public.app_user
for each row execute function public.set_updated_at();

-- ------------------------------------------------------- helper predicates
-- Used by policies and callable from the service layer so that one definition
-- of "is an admin" is shared rather than repeated.

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.app_user
      where id = auth.uid() and is_active),
    'anonymous'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_app_role() = 'admin';
$$;

-- --------------------------------------------------------------- policies
-- Reading the catalogue stays open, which is what the deployed prototype does
-- today and what the client has seen. Everything that writes is closed.

alter table public.app_user enable row level security;

drop policy if exists "Users read their own profile" on public.app_user;
create policy "Users read their own profile"
on public.app_user for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage users" on public.app_user;
create policy "Admins manage users"
on public.app_user for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

revoke all on table public.app_user from anon;

-- The audit trail should be readable by an admin rather than by nobody, so that
-- the approval history can actually be inspected in the interface.

drop policy if exists "Admins read the audit trail" on public.api_audit_events;
create policy "Admins read the audit trail"
on public.api_audit_events for select
to authenticated
using (public.is_admin());

-- ------------------------------------------------ verification provenance
-- verified_by is free text today, so a record can claim any verifier. Point it
-- at a real account instead, and keep the text column for records verified
-- before this migration.

alter table public.apis
  add column if not exists verified_by_user uuid references public.app_user (id);

comment on column public.apis.verified_by_user is
  'The account that set review_status to Verified. verified_by is retained for
   records verified before access control existed.';

-- The rule that only an administrator may set review_status to 'Verified' is
-- deliberately NOT enforced here. It lives in a later migration, applied once
-- sign-in exists.
--
-- Enforcing it now would stop verification outright. A database trigger fires
-- regardless of privilege -- unlike row-level security, the service key does
-- not bypass it -- and with no sign-in there is no session for auth.uid() to
-- resolve, so is_admin() is false for every caller including the API route.
-- Verified locally against Postgres 16: the update is refused both on an
-- ordinary connection and as the database owner.
--
-- Section C's manual verification work would be blocked from the moment this
-- migration reached Supabase. So the identities land now and the enforcement
-- follows in 0006_enforce_verification_admin.sql.
