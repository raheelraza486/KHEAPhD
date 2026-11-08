-- Existing notifications and the verification trigger keep their original kind.
alter table public.api_notifications
  add column kind text not null default 'api_verified'
  check (kind in ('api_verified', 'new_submission', 'api_updated', 'changes_requested'));

-- Both URL imports and uploaded APIs insert into this table. Notify every active
-- administrator in the same transaction, only for a new user-owned submission.
-- Skipped duplicates, edits, failed inserts and admin imports do not notify.
create function public.notify_api_submitted()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.is_active and new.duplicate_of is null
     and exists (
       select 1 from public.app_user
       where id = new.created_by_user and is_active and role <> 'admin'
     ) then
    insert into public.api_notifications (recipient_user_id, api_id, api_name, kind)
    select id, new.id, new.api_name, 'new_submission'
    from public.app_user
    where role = 'admin' and is_active;
  end if;
  return new;
end;
$$;
revoke all on function public.notify_api_submitted() from public, anon, authenticated;

create trigger notify_apis_submitted
after insert on public.apis
for each row execute function public.notify_api_submitted();

-- Feedback uses the existing public review note while the API awaits review.
-- Changing status and notifying the submitter commit in the same transaction.
create function public.notify_api_feedback()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.is_active and new.duplicate_of is null and new.review_status = 'Published'
     and btrim(new.verification_notes) <> ''
     and (new.verification_notes is distinct from old.verification_notes or old.review_status = 'Verified')
     and exists (select 1 from public.app_user where id = new.created_by_user and is_active and role <> 'admin') then
    insert into public.api_notifications (recipient_user_id, api_id, api_name, kind)
    values (new.created_by_user, new.id, new.api_name, 'changes_requested');
  end if;
  return new;
end;
$$;
revoke all on function public.notify_api_feedback() from public, anon, authenticated;
create trigger notify_apis_feedback
after update of review_status, verification_notes on public.apis
for each row execute function public.notify_api_feedback();

-- A successful owner edit (including schema uploads/recovery) creates one audit
-- event. Use its trusted actor id so admin maintenance never alerts other admins.
create function public.notify_api_updated()
returns trigger language plpgsql security definer set search_path = public
as $$
declare target public.apis;
begin
  if new.action <> 'edit' then return new; end if;
  select * into target from public.apis where id = new.api_id and is_active and duplicate_of is null;
  if target.id is not null and target.created_by_user = new.actor_user_id
     and exists (select 1 from public.app_user where id = new.actor_user_id and is_active and role <> 'admin') then
    insert into public.api_notifications (recipient_user_id, api_id, api_name, kind)
    select id, target.id, target.api_name, 'api_updated' from public.app_user where is_active and role = 'admin';
  end if;
  return new;
end;
$$;
revoke all on function public.notify_api_updated() from public, anon, authenticated;
create trigger notify_api_owner_edits
after insert on public.api_audit_events
for each row execute function public.notify_api_updated();

-- Schema content is part of the API being verified. Invalidate the parent in
-- the same transaction as each content change, including direct maintenance.
create function public.invalidate_schema_verification()
returns trigger language plpgsql security definer set search_path = public
as $$
declare affected uuid[];
begin
  if tg_op = 'UPDATE' and new is not distinct from old then return new; end if;
  if tg_table_name = 'api_schema' then
    if tg_op = 'INSERT' then affected := array[new.api_id];
    elsif tg_op = 'DELETE' then affected := array[old.api_id];
    else affected := array[old.api_id, new.api_id]; end if;
  else
    if tg_op = 'INSERT' then select array_agg(api_id) into affected from public.api_schema where id = new.schema_id;
    elsif tg_op = 'DELETE' then select array_agg(api_id) into affected from public.api_schema where id = old.schema_id;
    else select array_agg(api_id) into affected from public.api_schema where id in (old.schema_id, new.schema_id); end if;
  end if;
  update public.apis set review_status = 'Published', verified_at = null, verified_by = '',
    verified_by_user = null, verification_notes = ''
  where id = any(affected) and is_active and (review_status = 'Verified' or verification_notes <> '');
  return null;
end;
$$;
revoke all on function public.invalidate_schema_verification() from public, anon, authenticated;
create trigger invalidate_api_schema_review
after insert or update or delete on public.api_schema
for each row execute function public.invalidate_schema_verification();
create trigger invalidate_api_schema_field_review
after insert or update or delete on public.api_schema_field
for each row execute function public.invalidate_schema_verification();
