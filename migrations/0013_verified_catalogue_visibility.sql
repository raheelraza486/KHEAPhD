-- Publish catalogue records only after administrator verification.
--
-- `Published` is the existing database value used for a newly submitted
-- record. Despite that historical name, it is an internal review state: the
-- user-facing catalogue must not expose it until an administrator records an
-- official-source check and changes the row to `Verified`.
--
-- Keep the rule at the database boundary as well as in the application. This
-- protects direct PostgREST reads and makes `v_catalogue` safe to grant to
-- anonymous and authenticated callers. Administrators retain access to every
-- row for review, including inactive and duplicate records.

alter table public.apis enable row level security;

drop policy if exists "Reviewed active APIs are readable" on public.apis;
drop policy if exists "Active APIs are readable" on public.apis;
drop policy if exists "Verified catalogue APIs are publicly readable" on public.apis;
drop policy if exists "Admins read all APIs" on public.apis;

create policy "Verified catalogue APIs are publicly readable"
on public.apis
for select
to anon, authenticated
using (
  is_active = true
  and review_status = 'Verified'
  and duplicate_of is null
);

create policy "Admins read all APIs"
on public.apis
for select
to authenticated
using (public.is_admin());

-- `security_invoker` views require the caller to be allowed to select from the
-- underlying table. Supabase normally grants this by default; state it here so
-- a locally migrated database has the same behaviour. RLS above still limits
-- which rows each caller receives.
grant select on table public.apis to anon, authenticated;

-- PostgreSQL views use their owner's privileges by default, which can bypass
-- row-level security on the underlying table. `security_invoker` makes the
-- caller's policies apply. The explicit predicate is retained as defence in
-- depth and documents the catalogue contract independently of those policies.
create or replace view public.v_catalogue
with (security_invoker = true)
as
  select *
  from public.apis
  where is_active = true
    and duplicate_of is null
    and (review_status = 'Verified' or public.is_admin());

comment on view public.v_catalogue is
  'User-facing catalogue records: active, non-duplicate and Verified. An
   authenticated administrator may also see active records awaiting review;
   administration of inactive or duplicate rows uses public.apis directly.';

grant select on public.v_catalogue to anon, authenticated;
