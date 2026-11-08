-- A confirmed URL import must identify the person or team taking responsibility
-- for the submission. The UI and API both enforce this; this constraint is the
-- final database guard.
--
-- NOT VALID avoids rejecting the migration when historical imported sessions
-- predate required attribution. PostgreSQL still enforces it for every new or
-- subsequently updated row. Historical rows can be backfilled and the
-- constraint validated separately.

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'import_session_imported_submitter_check'
       and conrelid = 'public.import_session'::regclass
  ) then
    alter table public.import_session
      add constraint import_session_imported_submitter_check
      check (
        outcome <> 'imported'
        or (
          submitted_by is not null
          and char_length(submitted_by) between 1 and 120
          and submitted_by !~ '^[[:space:]]*$'
        )
      ) not valid;
  end if;
end
$$;

comment on column public.import_session.submitted_by is
  'Self-declared person or team responsible for the submission; required when outcome is imported.';
