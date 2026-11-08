-- 0023  A verification that survives a change to what was verified
--
-- The application already has the right rule. PATCH /api/apis edits a record
-- and, in the same write, sets review_status back to 'Published', clears
-- verified_at, verified_by and verification_notes, and records "Edited API
-- details; returned to awaiting verification." Fourteen fields are editable
-- there -- the name, the company, the endpoint, the documentation URL, the
-- category, the communication direction and the authentication fields.
--
-- The rule lives only in that route. A write that reaches the table another
-- way keeps the verification, and this session made a great many such writes:
-- the format corrections, the endpoint corrections for Türkiye and Storecove,
-- the methods, the operation selectors. 150 records now carry a verification
-- with a later 'edit' event -- not all from this session, and not all of them
-- meaningful: Hungary's and Poland's are schema extractions logged as edits,
-- which changed nothing a person had checked. The ones that matter are the
-- records where a verified field itself changed.
--
-- So the rule moves to where it cannot be bypassed. This is the same choice
-- 0019 made for schemas, where a verification is bound to the content_hash it
-- was of: state the invariant in the database rather than in one code path.
--
-- input_formats and output_formats are included even though the route does not
-- edit them, because they are exactly what went wrong: 37 records were marked
-- Verified while saying JSON for a service whose own WSDL says text/xml. A
-- verification that passed a wrong format is evidence the check did not cover
-- it, and the honest state afterwards is "needs looking at again".
--
-- Deliberately not done: nothing is reset retroactively. A trigger cannot see
-- the past, and clearing 150 verifications would discard other people's work
-- on a rule they were never given -- most of those records had only a method
-- filled, a column that was null when they were verified. The count is in
-- v_verification_drift for a person to work through.

create or replace function public.clear_verification_on_change()
returns trigger
language plpgsql
as $$
begin
  -- Only a record that claims verification has anything to lose.
  if old.review_status <> 'Verified' then
    return new;
  end if;
  -- A change to any field a verification covers returns the record to the
  -- queue. Ordinary bookkeeping -- http_method, operation_selector,
  -- data_quality, duplicate_of -- does not: those are not what a person
  -- checked, and treating them as edits would make routine curation destroy
  -- verification records.
  if new.api_name is distinct from old.api_name
     or new.company_name is distinct from old.company_name
     or new.api_endpoint is distinct from old.api_endpoint
     or new.documentation_url is distinct from old.documentation_url
     or new.description is distinct from old.description
     or new.category is distinct from old.category
     or new.communication_direction is distinct from old.communication_direction
     or new.authentication_method is distinct from old.authentication_method
     or new.authentication_details is distinct from old.authentication_details
     or new.input_formats is distinct from old.input_formats
     or new.output_formats is distinct from old.output_formats
  then
    new.review_status := 'Published';
    new.verified_at := null;
    new.verified_by := '';
    new.verified_by_user := null;
    new.verification_notes := '';
  end if;
  return new;
end;
$$;

comment on function public.clear_verification_on_change() is
  'Returns a record to awaiting verification when a field its verification
   covered changes. The same rule PATCH /api/apis applies, stated where a
   direct SQL write cannot go around it. Bookkeeping columns are excluded on
   purpose -- filling http_method or operation_selector is not an edit to what
   a person checked.';

drop trigger if exists apis_clear_verification on public.apis;
create trigger apis_clear_verification
  before update on public.apis
  for each row execute function public.clear_verification_on_change();

-- --------------------------------------------------------------- the backlog

create or replace view public.v_verification_drift as
  select a.id,
         a.api_name,
         a.company_name,
         a.review_status,
         a.verified_at,
         a.verified_by,
         (select max(e.action_at) from public.api_audit_events e
           where e.api_id = a.id and e.action = 'edit' and e.action_at > a.verified_at)
           as last_edit_after_verification,
         (select count(*) from public.api_schema s
           where s.api_id = a.id
             and (s.verified_at is null or s.verified_content_hash is distinct from s.content_hash))
           as unverified_schemas
    from public.apis a
   where a.is_active
     and a.duplicate_of is null
     and a.review_status = 'Verified'
     and a.verified_at is not null
     and exists (select 1 from public.api_audit_events e
                  where e.api_id = a.id and e.action = 'edit' and e.action_at > a.verified_at);

comment on view public.v_verification_drift is
  'Records that claim verification and have an edit recorded after it. These
   predate the trigger in 0023, which stops the state arising again. Read the
   audit trail before acting on a row: some of these edits are schema
   extractions logged as edits and changed nothing a person had checked, while
   others changed a format or an endpoint. unverified_schemas is the same
   record counted by v_schema_verification_queue.';

grant select on public.v_verification_drift to authenticated;
