begin;

create table public.saved_chain (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.app_user(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  api_ids uuid[] not null check (cardinality(api_ids) between 1 and 4 and array_position(api_ids, null) is null),
  created_at timestamptz not null default now(),
  unique (owner_id, name, api_ids)
);

create index saved_chain_owner_recent on public.saved_chain (owner_id, created_at desc, id);
alter table public.saved_chain enable row level security;
revoke all on public.saved_chain from public, anon, authenticated;
grant select, delete on public.saved_chain to authenticated;
grant insert (name, api_ids), update (name) on public.saved_chain to authenticated;

create policy "Active users manage their own saved chains"
on public.saved_chain for all to authenticated
using (owner_id = (select auth.uid()) and (select public.current_app_role()) <> 'anonymous')
with check (owner_id = (select auth.uid()) and (select public.current_app_role()) <> 'anonymous');

commit;
