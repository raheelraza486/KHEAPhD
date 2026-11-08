-- Hard deletion is appropriate for a real operation that is wholly outside the
-- catalogue scope, fabricated data, or test data.  The heavy API and schema
-- rows may be removed, but a small audit tombstone must survive so the decision
-- remains answerable. api_audit_events.api_id deliberately has no foreign key
-- to public.apis, so it can retain that tombstone.
--
-- The 28 INFast operations removed before this rule existed still have orphaned
-- upload/edit/verify events. Record their known reason without inventing an
-- original deletion timestamp or actor.

alter table public.api_audit_events
  add column if not exists removal_reason_code text,
  add column if not exists removal_import_session_id uuid;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'api_audit_events_removal_reason_check'
       and conrelid = 'public.api_audit_events'::regclass
  ) then
    alter table public.api_audit_events
      add constraint api_audit_events_removal_reason_check
      check (
        removal_reason_code is null
        or (
          action = 'delete'
          and removal_reason_code in (
            'outside_catalogue_scope',
            'fabricated',
            'invalid_api',
            'test_data'
          )
        )
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'api_audit_events_removal_import_session_fkey'
       and conrelid = 'public.api_audit_events'::regclass
  ) then
    alter table public.api_audit_events
      add constraint api_audit_events_removal_import_session_fkey
      foreign key (removal_import_session_id) references public.import_session(id)
      on delete set null;
  end if;
end
$$;

comment on column public.api_audit_events.removal_reason_code is
  'Structured reason for a permanent catalogue removal. Null on ordinary history and reversible soft deletions.';

comment on column public.api_audit_events.removal_import_session_id is
  'Import session whose scope or safety decision led to this permanent removal, when one exists.';

with removed_infast as (
  select distinct on (e.api_id)
         e.api_id,
         e.api_name,
         e.company_name
    from public.api_audit_events e
    left join public.apis a on a.id = e.api_id
   where a.id is null
     and e.company_name = 'Intia Dev Team'
     and e.api_name like 'INFast API %'
     and not exists (
       select 1
         from public.api_audit_events deletion
        where deletion.api_id = e.api_id
          and deletion.action = 'delete'
     )
   order by e.api_id, e.action_at desc
)
insert into public.api_audit_events (
  api_id,
  api_name,
  company_name,
  action,
  actor_name,
  actor_user_id,
  removal_reason_code,
  details
)
select api_id,
       api_name,
       company_name,
       'delete',
       'System migration',
       null,
       'outside_catalogue_scope',
       jsonb_build_object(
         'type', 'catalogue_removal',
         'reason_code', 'outside_catalogue_scope',
         'rule_id', 'infast_reviewed_scope_v1',
         'recorded_retrospectively', true,
         'summary', 'The operation is real but outside the e-invoicing catalogue scope.'
       )::text
  from removed_infast;

-- A direct DELETE without a durable structured reason is a programming error.
-- The supported hard-delete function writes the tombstone first in the same
-- transaction; if either step fails, neither persists.
create or replace function public.require_api_hard_delete_audit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
      from public.api_audit_events event
     where event.api_id = old.id
       and event.action = 'delete'
       and event.removal_reason_code is not null
  ) then
    raise exception 'A structured removal audit event is required before hard-deleting API %.', old.id
      using errcode = '23514';
  end if;
  return old;
end;
$$;

revoke all on function public.require_api_hard_delete_audit() from public, anon, authenticated;

drop trigger if exists apis_require_hard_delete_audit on public.apis;
create trigger apis_require_hard_delete_audit
  before delete on public.apis
  for each row execute function public.require_api_hard_delete_audit();

create or replace function public.admin_hard_delete_api(
  p_api_id uuid,
  p_actor_user_id uuid,
  p_reason_code text,
  p_reason_note text default '',
  p_import_session_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.apis%rowtype;
  actor_display_name text;
  reason_summary text;
begin
  select left(coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.email), ''), 'Authenticated user'), 120)
    into actor_display_name
    from public.app_user u
   where u.id = p_actor_user_id
     and u.role = 'admin'
     and u.is_active;
  if not found then
    raise exception 'An active administrator is required.' using errcode = '42501';
  end if;

  if p_reason_code is null
     or p_reason_code not in ('outside_catalogue_scope', 'fabricated', 'invalid_api', 'test_data') then
    raise exception 'A supported permanent-removal reason is required.' using errcode = '22023';
  end if;
  if length(coalesce(p_reason_note, '')) > 1000 then
    raise exception 'The permanent-removal note must not exceed 1000 characters.' using errcode = '22023';
  end if;
  if p_import_session_id is not null
     and not exists (select 1 from public.import_session where id = p_import_session_id) then
    raise exception 'Import session % was not found.', p_import_session_id using errcode = 'P0002';
  end if;

  select a.* into target
    from public.apis a
   where a.id = p_api_id
   for update;
  if not found then
    raise exception 'API % was not found.', p_api_id using errcode = 'P0002';
  end if;
  if exists (select 1 from public.apis where duplicate_of = target.id) then
    raise exception 'API % is retained as the canonical target of a duplicate pointer.', target.id
      using errcode = '23503';
  end if;

  reason_summary := case p_reason_code
    when 'outside_catalogue_scope' then 'The operation is real but outside the e-invoicing catalogue scope.'
    when 'fabricated' then 'The catalogue record was determined to be fabricated.'
    when 'invalid_api' then 'The record does not describe a valid API operation.'
    when 'test_data' then 'The record is test data and does not belong in the catalogue.'
  end;

  insert into public.api_audit_events (
    api_id,
    api_name,
    company_name,
    action,
    actor_name,
    actor_user_id,
    removal_reason_code,
    removal_import_session_id,
    details
  ) values (
    target.id,
    target.api_name,
    target.company_name,
    'delete',
    actor_display_name,
    p_actor_user_id,
    p_reason_code,
    p_import_session_id,
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'catalogue_removal',
      'reason_code', p_reason_code,
      'import_session_id', p_import_session_id,
      'summary', reason_summary,
      'note', nullif(btrim(coalesce(p_reason_note, '')), '')
    ))::text
  );

  delete from public.apis where id = target.id;
  return target.id;
end;
$$;

comment on function public.admin_hard_delete_api(uuid, uuid, text, text, uuid) is
  'Permanently removes one out-of-scope, fabricated, invalid, or test API and its cascaded schema only after writing a durable audit tombstone in the same transaction.';

revoke all on function public.admin_hard_delete_api(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_hard_delete_api(uuid, uuid, text, text, uuid) to service_role;
