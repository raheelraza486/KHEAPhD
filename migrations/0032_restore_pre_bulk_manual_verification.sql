-- Restore the record-level verifications a person actually performed.
--
-- 0029 returned every record to 'Published' because the administrator bulk
-- update had marked all of them Verified from a reviewed spreadsheet, which is
-- curation rather than verification against a provider's document. That was
-- right, but it was too broad: the same bulk run had already overwritten the
-- verification state of records a person had checked one at a time between
-- 4 and 13 September, so 0029 swept those away with the rest.
--
-- The evidence survives in api_audit_events, and only because migration 0026
-- was changed to narrow audit text at the read boundary instead of rewriting
-- the stored rows. 157 'verify' events across 151 records predate the bulk run
-- of 15 September, and each carries a note specific to that API -- for
-- example "NFeDistribuicaoDFe is used to distribute and download ...". A note
-- about what this particular service does is evidence that somebody read the
-- record, which is what review_status = 'Verified' asserts under 0006.
--
-- What is restored, and from where: nothing is invented.
--
--   review_status      'Verified'
--   verified_at        the timestamp of that record's LAST pre-15-September
--                      verify event, not now(). set_verified_at uses
--                      coalesce(new.verified_at, now()), so an explicit value
--                      is preserved.
--   verified_by        'Repository administrator', as the event records
--   verified_by_user   the actor_user_id on that event
--   verification_notes the text after 'Note: ' in that event's details
--
-- 150 of the 151 are still in the catalogue; the other was removed on
-- 16 September as out of scope and is deliberately not resurrected.
--
-- What this does NOT assert. This is record-level verification under 0006 --
-- somebody read the record's own metadata. It says nothing about the stored
-- schemas: api_schema.verified_at is null for all 301 of them under 0019, no
-- schema has been checked against a provider's document by a person, and every
-- transcribed record still carries NOT YET VERIFIED BY A PERSON in its audit
-- trail. The two flags mean different things and this migration only restores
-- the first.
--
-- An independently authored verification is not touched: the filter is the
-- record's own pre-bulk verify event, and records verified only by the bulk
-- run match nothing here and stay 'Published'.

with pre_bulk as (
  select distinct on (event.api_id)
         event.api_id,
         event.action_at,
         event.actor_user_id,
         event.actor_name,
         nullif(btrim(regexp_replace(event.details, '^.*?Note:\s*', '')), '') as note
    from public.api_audit_events event
   where event.action = 'verify'
     and event.action_at < '2026-09-15'
   order by event.api_id, event.action_at desc
),
restored as (
  update public.apis a
     set review_status      = 'Verified',
         verified_at        = pre_bulk.action_at,
         verified_by        = pre_bulk.actor_name,
         verified_by_user   = pre_bulk.actor_user_id,
         verification_notes = coalesce(pre_bulk.note, '')
    from pre_bulk
   where a.id = pre_bulk.api_id
     and a.is_active
     and a.duplicate_of is null
     and a.review_status = 'Published'
  returning a.id, a.api_name, a.company_name, pre_bulk.action_at
)
insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select restored.id,
       restored.api_name,
       restored.company_name,
       'status_change',
       'Repository administrator',
       '049e2fcd-3a80-4219-b1bb-62ace9f3dc28'::uuid,
       'Verification restored to the state a person recorded on '
         || restored.action_at::date
         || '. The administrator bulk metadata update of 15 September had overwritten it, and '
         || 'migration 0029 then returned every bulk-marked record to Published; this record was '
         || 'verified individually before that run, so its own verified_at, actor and note are '
         || 'restored from its audit history rather than re-asserted today. This is record-level '
         || 'verification under 0006 and says nothing about the stored schemas, none of which has '
         || 'been checked against a provider document by a person.'
  from restored;
