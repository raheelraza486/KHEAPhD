-- Repository schema
--
-- This is schema.sql from the Business API Ecosystem application, unchanged
-- apart from this header. It was previously applied by pasting it into the
-- Supabase SQL editor by hand; recording it as a numbered migration is what
-- lets scripts/migrate.sh know whether it has been applied.
--
-- It belongs to the Repository pod. It is placed here so that the migration
-- sequence is complete and 0003 has the tables it depends on; whether the
-- root-level schema.sql is then removed is their call, not Pod A's. Two copies
-- of the same schema will drift.
--
-- The file is already written to be idempotent, so applying it to the existing
-- Supabase database prints "already exists, skipping" and changes nothing.

-- Run once in Supabase SQL Editor

create extension if not exists pgcrypto;

create table if not exists public.apis (
  id uuid primary key default gen_random_uuid(),

  api_name text not null,
  official_api_name text not null default '',
  description text not null,
  api_endpoint text not null,
  instructions text not null default '',

  company_name text not null,
  official_company_name text not null default '',
  website_url text not null default '',
  documentation_url text not null,

  category text not null,
  category_other text not null default '',

  authentication_method text not null,
  authentication_other text not null default '',
  authentication_details text not null default '',

  network text not null default '',
  is_active boolean not null default true,

  input_formats text[] not null default '{}',
  output_formats text[] not null default '{}',
  business_rules text[] not null default '{}',
  client_types text[] not null default '{}',

  review_status text not null default 'Published',
  verified_by text not null default '',
  verification_notes text not null default '',
  verified_at timestamptz,

  source_url text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migration for older existing databases.
alter table public.apis
  add column if not exists official_api_name text not null default '',
  add column if not exists official_company_name text not null default '',
  add column if not exists authentication_details text not null default '',
  add column if not exists category_other text not null default '',
  add column if not exists authentication_other text not null default '',
  add column if not exists verified_by text not null default '',
  add column if not exists verification_notes text not null default '';

alter table public.apis
  alter column review_status set default 'Published';

update public.apis
set review_status = case
  when review_status = 'Verified candidate' then 'Verified'
  when review_status = 'Draft' then 'Published'
  else review_status
end
where review_status in ('Verified candidate', 'Draft');

alter table public.apis
  drop constraint if exists apis_review_status_check;

alter table public.apis
  add constraint apis_review_status_check
  check (review_status in ('Published', 'Verified'));

create unique index if not exists apis_company_api_unique
  on public.apis (lower(company_name), lower(api_name));

create index if not exists apis_active_status_idx
  on public.apis (is_active, review_status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.set_verified_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.review_status = 'Verified' then
    new.verified_at = coalesce(new.verified_at, now());
  else
    new.verified_at = null;
  end if;

  return new;
end;
$$;

drop trigger if exists set_apis_updated_at on public.apis;

create trigger set_apis_updated_at
before update on public.apis
for each row execute function public.set_updated_at();

drop trigger if exists set_apis_verified_at on public.apis;

create trigger set_apis_verified_at
before insert or update of review_status on public.apis
for each row execute function public.set_verified_at();

alter table public.apis enable row level security;

drop policy if exists "Reviewed active APIs are readable" on public.apis;
drop policy if exists "Active APIs are readable" on public.apis;

create policy "Active APIs are readable"
on public.apis
for select
to anon, authenticated
using (is_active = true);

revoke insert, update, delete
on table public.apis
from anon, authenticated;


-- Audit history

create table if not exists public.api_audit_events (
  id uuid primary key default gen_random_uuid(),

  api_id uuid not null,
  api_name text not null,
  company_name text not null,

  action text not null check (
    action in ('upload', 'edit', 'verify', 'status_change', 'delete')
  ),

  actor_name text not null,
  details text not null default '',
  action_at timestamptz not null default now()
);

create index if not exists api_audit_events_api_id_idx
  on public.api_audit_events (api_id, action_at desc);

alter table public.api_audit_events enable row level security;

revoke all
on table public.api_audit_events
from anon, authenticated;

alter table public.api_audit_events
drop constraint if exists api_audit_events_action_check;

alter table public.api_audit_events
add constraint api_audit_events_action_check
check (
  action in (
    'upload',
    'edit',
    'verify',
    'status_change',
    'delete',
    'restore'
  )
);
