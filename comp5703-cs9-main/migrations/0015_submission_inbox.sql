-- Ownership already exists in 0011. Application routes authorize owner edits
-- and soft deletes; direct catalogue writes remain closed to browser roles.
comment on column public.app_user.role is
  'viewer — legacy account; may manage any submissions it already owns.
   publisher — submit APIs, edit/delete own submissions at any review status.
   admin — manage and verify all APIs.';

create policy "Owners read their submitted APIs"
on public.apis for select to authenticated
using (created_by_user = auth.uid() and public.current_app_role() <> 'anonymous');

create policy "Owners read their submission history"
on public.api_audit_events for select to authenticated
using (
  public.current_app_role() <> 'anonymous'
  and exists (
    select 1 from public.apis
    where apis.id = api_audit_events.api_id and apis.created_by_user = auth.uid()
  )
);
grant select on public.api_audit_events to authenticated;

create table public.api_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.app_user(id) on delete cascade,
  api_id uuid references public.apis(id) on delete set null,
  api_name text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index api_notifications_recipient_idx
  on public.api_notifications (recipient_user_id, created_at desc, id desc);
create index api_notifications_unread_idx
  on public.api_notifications (recipient_user_id) where read_at is null;

alter table public.api_notifications enable row level security;
revoke all on public.api_notifications from anon, authenticated;
grant select, update (read_at) on public.api_notifications to authenticated;
grant all on public.api_notifications to service_role;

create policy "Recipients read their inbox"
on public.api_notifications for select to authenticated
using (recipient_user_id = auth.uid() and public.current_app_role() <> 'anonymous');

create policy "Recipients mark their notifications read"
on public.api_notifications for update to authenticated
using (recipient_user_id = auth.uid() and public.current_app_role() <> 'anonymous')
with check (recipient_user_id = auth.uid() and public.current_app_role() <> 'anonymous');

-- A status transition and its notification commit together. Re-saving an
-- already verified API does not send duplicates; re-verifying after an edit does.
create function public.notify_api_verified()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.review_status = 'Verified'
     and old.review_status is distinct from 'Verified'
     and new.created_by_user is not null
     and new.is_active and new.duplicate_of is null then
    insert into public.api_notifications (recipient_user_id, api_id, api_name)
    values (new.created_by_user, new.id, new.api_name);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_api_verified() from public, anon, authenticated;

create trigger notify_apis_verified
after update of review_status on public.apis
for each row execute function public.notify_api_verified();
