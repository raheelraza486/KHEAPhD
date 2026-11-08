-- A reviewed metadata workbook is curation, not manual verification against a
-- provider's official document. Correct only rows carrying the exact marker
-- written by the bulk-update workflow, plus the one historical row whose
-- verification note explicitly says its URL is unverified. Do not disturb an
-- independently authored verification.

with candidates as (
  select id,
         verification_notes as previous_note
    from public.apis
   where review_status = 'Verified'
     and verified_by = 'Repository administrator'
     and verification_notes in (
       'Administrator bulk metadata update from a reviewed spreadsheet. Official sources are recorded in the audit history.',
       'Metadata reviewed by a repository administrator.',
       'Unverified URL; official endpoint required.'
     )
),
corrected as (
  update public.apis a
     set review_status = 'Published',
         verified_at = null,
         verified_by = '',
         verified_by_user = null,
         verification_notes = ''
    from candidates
   where a.id = candidates.id
  returning a.id, a.api_name, a.company_name, candidates.previous_note
)
insert into public.api_audit_events (
  api_id,
  api_name,
  company_name,
  action,
  actor_name,
  actor_user_id,
  details
)
select id,
       api_name,
       company_name,
       'status_change',
       'System migration',
       null,
       jsonb_build_object(
         'type', 'verification_status_correction',
         'reason_code', 'manual_official_source_verification_not_performed',
         'previous_status', 'Verified',
         'new_status', 'Published',
         'summary', case
           when previous_note = 'Unverified URL; official endpoint required.'
             then 'The previous note explicitly said the official endpoint was unverified.'
           else 'Metadata was curated, but no manual check against an official provider source was performed.'
         end
       )::text
  from corrected;

comment on column public.apis.review_status is
  'Published means publicly listed and awaiting an official-source check. Verified means an administrator manually checked the API metadata against an official provider source.';
