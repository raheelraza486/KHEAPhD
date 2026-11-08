-- Run against a local database after applying 0056. Fixtures are rolled back.
begin;

insert into auth.users (id, email) values
  ('00560000-0000-4000-8000-000000000001', 'chain-owner@example.test'),
  ('00560000-0000-4000-8000-000000000002', 'chain-admin@example.test');

insert into public.app_user (id, email, role) values
  ('00560000-0000-4000-8000-000000000001', 'chain-owner@example.test', 'publisher'),
  ('00560000-0000-4000-8000-000000000002', 'chain-admin@example.test', 'admin')
on conflict (id) do update set role = excluded.role;

set local role authenticated;
set local request.jwt.claim.sub = '00560000-0000-4000-8000-000000000001';

insert into public.saved_chain (name, api_ids) values
  ('Private test chain', array['00560000-0000-4000-8000-000000000022', '00560000-0000-4000-8000-000000000011']::uuid[])
on conflict (owner_id, name, api_ids) do nothing;

insert into public.saved_chain (name, api_ids) values
  ('Private test chain', array['00560000-0000-4000-8000-000000000022', '00560000-0000-4000-8000-000000000011']::uuid[])
on conflict (owner_id, name, api_ids) do nothing;

do $$
begin
  if (select count(*) from public.saved_chain where name = 'Private test chain'
      and owner_id = '00560000-0000-4000-8000-000000000001'
      and api_ids = array['00560000-0000-4000-8000-000000000022', '00560000-0000-4000-8000-000000000011']::uuid[]) <> 1 then
    raise exception 'The owner or step order was lost, or retry created a duplicate';
  end if;
  if has_column_privilege(current_user, 'public.saved_chain', 'owner_id', 'INSERT, UPDATE') then
    raise exception 'An account may assign ownership directly';
  end if;
end $$;

set local request.jwt.claim.sub = '00560000-0000-4000-8000-000000000002';

do $$
begin
  if exists (select 1 from public.saved_chain where name = 'Private test chain') then
    raise exception 'Another account can read the chain';
  end if;
  update public.saved_chain set name = 'Taken over' where name = 'Private test chain';
  if found then raise exception 'Another account can rename the chain'; end if;
  delete from public.saved_chain where name = 'Private test chain';
  if found then raise exception 'Another account can delete the chain'; end if;
  if has_table_privilege('anon', 'public.saved_chain', 'SELECT') then
    raise exception 'Guests have read access';
  end if;
end $$;

set local request.jwt.claim.sub = '00560000-0000-4000-8000-000000000001';

do $$
begin
  update public.saved_chain set name = 'Renamed test chain' where name = 'Private test chain';
  if not found then raise exception 'The owner cannot rename the chain'; end if;
  delete from public.saved_chain where name = 'Renamed test chain';
  if not found then raise exception 'The owner cannot delete the chain'; end if;
end $$;

rollback;
