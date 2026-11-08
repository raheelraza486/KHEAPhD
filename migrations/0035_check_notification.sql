-- 0035  Telling the people who answered that an administrator has settled it.
--
-- When users disagree about which source field supplies a target field, the
-- field is held and an administrator settles it (migration 0033; Compatibility
-- Check Manual 10.25). The settlement is final and changes the verdict of that
-- pair, so the people who answered should learn the outcome. Nothing is sent
-- when the conflict arises: at that moment there is nothing the answerer can
-- do, and a message would only be noise.
--
-- Why a new table rather than `api_notifications`. That table is one row per
-- (person, API): it has a single `api_id` and its `kind` is constrained to the
-- four submission events of 0015/0017. A settlement is about an ordered *pair*
-- and a field within it, which a single `api_id` cannot express. Widening the
-- shared table would also change a table and a route the rest of the catalogue
-- depends on. The inbox in the page reads both tables and shows one list, so
-- the split is not visible to the reader.
--
-- This migration is self-contained: it depends on nothing that 0034 changes,
-- and may be applied before or after it.

create table if not exists public.check_notification (
  id                   uuid primary key default gen_random_uuid(),

  recipient_user_id    uuid not null references public.app_user (id) on delete cascade,

  -- The ordered pair and the field the settlement was about.
  source_api_id        uuid not null references public.apis (id) on delete cascade,
  target_api_id        uuid not null references public.apis (id) on delete cascade,
  target_path          text not null,

  -- Names are copied so the inbox reads in one query and still says something
  -- sensible after a record is renamed or removed.
  source_api_name      text not null default '',
  target_api_name      text not null default '',

  -- 'conflict_settled' is the only event for now; the column exists so a later
  -- event does not need another table.
  kind                 text not null default 'conflict_settled',

  -- What the administrator decided, so the inbox can say it without running
  -- the checks again.
  option               text not null,
  chosen_source_path   text,
  settled_by           uuid references public.app_user (id) on delete set null,

  created_at           timestamptz not null default now(),
  read_at              timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'check_notification_kind_check') then
    alter table public.check_notification add constraint check_notification_kind_check
      check (kind in ('conflict_settled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'check_notification_option_check') then
    alter table public.check_notification add constraint check_notification_option_check
      check (option in ('candidate', 'none', 'external'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'check_notification_pair_check') then
    alter table public.check_notification add constraint check_notification_pair_check
      check (source_api_id <> target_api_id and target_path <> '');
  end if;
end
$$;

create index if not exists check_notification_recipient_idx
  on public.check_notification (recipient_user_id, created_at desc, id desc);
create index if not exists check_notification_unread_idx
  on public.check_notification (recipient_user_id) where read_at is null;

comment on table public.check_notification is
  'One row per person told that an administrator settled a field they had
   answered for an ordered API pair (Compatibility Check Manual 10.25). The
   inbox merges these with public.api_notifications.';
comment on column public.check_notification.option is
  'The settled answer: candidate (chosen_source_path is set), none
   ("None of the above"), external ("Provided externally").';

-- Read and marked read by the recipient through their own session, exactly as
-- 0015 allows for api_notifications; written only by the application's routes
-- with the service key.
alter table public.check_notification enable row level security;
revoke all on public.check_notification from anon, authenticated;
grant select, update (read_at) on public.check_notification to authenticated;
grant all on public.check_notification to service_role;

drop policy if exists "Recipients read their settlement notices" on public.check_notification;
create policy "Recipients read their settlement notices"
on public.check_notification for select to authenticated
using (recipient_user_id = auth.uid() and public.current_app_role() <> 'anonymous');

drop policy if exists "Recipients mark their settlement notices read" on public.check_notification;
create policy "Recipients mark their settlement notices read"
on public.check_notification for update to authenticated
using (recipient_user_id = auth.uid() and public.current_app_role() <> 'anonymous')
with check (recipient_user_id = auth.uid() and public.current_app_role() <> 'anonymous');
