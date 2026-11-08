-- 0019  Whether a person has checked a stored schema
--
-- 0006 gave a *record* a verification state, and required a name and a note
-- with it: review_status = 'Verified' means somebody checked the catalogue
-- fields -- the endpoint, the company, the documentation link. 0016 then gave
-- records stored schemas, and 0017 parameters, and nothing was added to say
-- whether anyone had checked *those*.
--
-- The two are not the same thing, and today the catalogue cannot tell them
-- apart. 117 records carry review_status = 'Verified' with a verified_at that
-- predates a schema they now hold: Hungary's 32 NAV records were verified on
-- 6 September and their schemas written on the 11th; Taiwan's 8 were verified
-- on the 13th and every one of their schemas was replaced on the 15th, from a
-- different source, because the first extraction had come from a third-party
-- file that named the wrong operation. The record-level flag is not wrong --
-- it never claimed to be about schemas -- but there is nothing it can be read
-- against.
--
-- Every schema written by the transcription work says NOT YET VERIFIED BY A
-- PERSON in its record's audit trail. That is prose: it cannot be queried,
-- and when somebody does check a schema there is nowhere to write it down, so
-- the next person cannot tell what has been done.
--
-- This gives a schema its own verification, and binds it to the *content*
-- rather than to the row. verified_content_hash holds the content_hash that
-- was checked; if the schema is later rewritten, its hash no longer matches
-- and it returns to the queue by itself. That is the exact failure the 117
-- records show, closed at the level where it happens.
--
-- Deliberately not done: nothing touches apis.review_status. Resetting 117
-- records would throw away verification work that was real -- most of those
-- records had only their formats or their method corrected, and the fields a
-- person checked still stand. The two states now exist side by side and can
-- be read against each other.

-- ------------------------------------------------------- api_schema columns

alter table public.api_schema
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by text not null default '',
  add column if not exists verification_notes text not null default '',
  add column if not exists verified_content_hash text;

comment on column public.api_schema.verified_at is
  'When a person checked this schema against the provider''s document. Null
   means nobody has.';
comment on column public.api_schema.verified_by is
  'Who checked it. Required whenever verified_at is set, the same rule 0006
   applies to a record.';
comment on column public.api_schema.verification_notes is
  'What they checked and what they found -- which document, which page or
   section, and anything that did not match.';
comment on column public.api_schema.verified_content_hash is
  'The content_hash that was verified. When it differs from content_hash the
   schema has been rewritten since, and the verification no longer describes
   what is stored, so v_schema_verification_queue lists it again.';

alter table public.api_schema
  drop constraint if exists api_schema_verification_shape;

-- A verification names a person, says something, and records what it was of.
alter table public.api_schema
  add constraint api_schema_verification_shape
  check (
    (verified_at is null and verified_by = '' and verification_notes = ''
     and verified_content_hash is null)
    or (verified_at is not null and verified_by <> '' and verification_notes <> ''
        and verified_content_hash is not null)
  );

-- ------------------------------------------------------------------- queue

create or replace view public.v_schema_verification_queue as
  select s.id as schema_id,
         s.api_id,
         a.api_name,
         a.company_name,
         a.documentation_url,
         s.direction,
         s.status_code,
         s.media_type,
         s.origin,
         s.source_url,
         (select count(*) from public.api_schema_field f where f.schema_id = s.id) as fields,
         case
           when s.verified_at is null then 'never verified'
           else 'rewritten since it was verified'
         end as reason,
         s.verified_at,
         s.verified_by
    from public.api_schema s
    join public.apis a on a.id = s.api_id
   where a.is_active
     and a.duplicate_of is null
     and (s.verified_at is null
          or s.verified_content_hash is distinct from s.content_hash);

comment on view public.v_schema_verification_queue is
  'Stored schemas a person has not checked, or has checked and which have been
   rewritten since. `reason` says which. It proposes; verifying is a person
   writing verified_at, verified_by, verification_notes and the
   verified_content_hash they checked. The order to work them in is not here:
   it depends on how many compatibility verdicts each one holds up, which the
   engine computes -- see VERIFICATION-WORKLIST.md in the share folder.';

grant select on public.v_schema_verification_queue to authenticated;
