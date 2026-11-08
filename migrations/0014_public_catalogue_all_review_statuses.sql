-- Pending and verified API listings are public. Verification records an
-- administrator's source check; it no longer gates catalogue visibility.
-- Supersedes 0013 without rewriting an already-applied migration.

alter table public.apis enable row level security;

drop policy if exists "Reviewed active APIs are readable" on public.apis;
drop policy if exists "Active APIs are readable" on public.apis;
drop policy if exists "Verified catalogue APIs are publicly readable" on public.apis;
drop policy if exists "Public catalogue APIs are readable" on public.apis;

create policy "Public catalogue APIs are readable"
on public.apis
for select
to anon, authenticated
using (is_active = true and duplicate_of is null);

-- The administrator policy from 0013 continues to allow inspection of inactive
-- and duplicate rows. Public access grants no mutation permissions.
grant select on table public.apis to anon, authenticated;

create or replace view public.v_catalogue
with (security_invoker = true)
as
  select *
  from public.apis
  where is_active = true
    and duplicate_of is null;

comment on view public.v_catalogue is
  'Public API catalogue: active, non-duplicate records, including APIs awaiting
   verification. Verification status describes a manual source check.';

grant select on public.v_catalogue to anon, authenticated;
