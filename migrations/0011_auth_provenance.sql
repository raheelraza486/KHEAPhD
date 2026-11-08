-- Bind application changes to verified Supabase Auth identities.
--
-- Supabase Auth owns credentials in auth.users. public.app_user owns the
-- application role and display name; passwords must never be copied here.
-- Existing catalogue and audit rows predate sign-in, so each provenance
-- column is intentionally nullable. New application writes always populate it.
--
-- Account access remains administrator-provisioned: this migration deliberately
-- creates no auth.users trigger and grants no automatic application role. An
-- administrator creates the Auth account, then explicitly inserts its matching
-- app_user row.

comment on column public.app_user.role is
  'viewer    — legacy read-only account.
   publisher — normal user: read the catalogue and submit new APIs; cannot edit existing records.
   admin     — publisher permissions plus edit, verification-status changes and soft delete.';

alter table public.apis
  add column if not exists created_by_user uuid;

alter table public.api_audit_events
  add column if not exists actor_user_id uuid;

alter table public.import_session
  add column if not exists created_by_user uuid,
  add column if not exists submitted_by_user uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'apis_created_by_user_fkey'
       and conrelid = 'public.apis'::regclass
  ) then
    alter table public.apis
      add constraint apis_created_by_user_fkey
      foreign key (created_by_user) references public.app_user (id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'api_audit_events_actor_user_id_fkey'
       and conrelid = 'public.api_audit_events'::regclass
  ) then
    alter table public.api_audit_events
      add constraint api_audit_events_actor_user_id_fkey
      foreign key (actor_user_id) references public.app_user (id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'import_session_created_by_user_fkey'
       and conrelid = 'public.import_session'::regclass
  ) then
    alter table public.import_session
      add constraint import_session_created_by_user_fkey
      foreign key (created_by_user) references public.app_user (id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'import_session_submitted_by_user_fkey'
       and conrelid = 'public.import_session'::regclass
  ) then
    alter table public.import_session
      add constraint import_session_submitted_by_user_fkey
      foreign key (submitted_by_user) references public.app_user (id)
      on delete set null;
  end if;
end
$$;

create index if not exists apis_created_by_user_idx
  on public.apis (created_by_user) where created_by_user is not null;

create index if not exists api_audit_events_actor_user_id_idx
  on public.api_audit_events (actor_user_id, action_at desc)
  where actor_user_id is not null;

create index if not exists import_session_created_by_user_idx
  on public.import_session (created_by_user, created_at desc)
  where created_by_user is not null;

comment on column public.apis.created_by_user is
  'Authenticated account that first added this API. Null only for historical or externally loaded rows.';

comment on column public.api_audit_events.actor_user_id is
  'Authenticated account responsible for the action. actor_name remains a display-name snapshot.';

comment on column public.api_audit_events.actor_name is
  'Display-name snapshot derived from the authenticated account; never accepted from a request body.';

comment on column public.import_session.created_by_user is
  'Authenticated account that created this preview. Only this account may confirm it.';

comment on column public.import_session.submitted_by_user is
  'Authenticated account that confirmed the import. submitted_by remains a display-name snapshot.';

comment on column public.import_session.submitted_by is
  'Display-name snapshot derived from the authenticated account that confirmed the import.';

-- A signed-in person may read only their own profile through the policy from
-- 0003. Role assignment stays out of the browser and is performed explicitly
-- by a service administrator or in the Supabase dashboard.
grant select on table public.app_user to authenticated;
revoke insert, update, delete on table public.app_user from anon, authenticated;
