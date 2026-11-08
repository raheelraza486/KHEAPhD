-- Record why a record could not be verified, so that "cannot check" is not
-- confused with "not genuine"
--
-- The client's rule, given at the meeting on 29 August and clarified in the
-- group afterwards, has three outcomes rather than two:
--
--   fabricated                  remove it
--   genuine but unreachable     keep it, and say why it could not be checked
--   genuine and reachable       keep it, and verify it normally
--
-- Those are different findings and must not collapse into one another. The
-- status checking form the client signed records 54 of the added records as
-- pending "due to regional restrictions, dynamic pages, or anti-bot controls
-- blocking automated evidence capture". None of those is evidence that a record
-- is fake -- only that nobody has been able to reach it yet.
--
-- 0004 gave data_quality three values, and none of them fits that case:
-- unreachable_documentation means the documentation URL is on a reserved domain
-- and can never resolve, which points at fabrication. This adds the value that
-- was missing.
--
-- Removal stays a soft delete: is_active = false, with the reason in
-- api_audit_events, so the evidence for the decision survives.

alter table public.apis drop constraint if exists apis_data_quality_check;

alter table public.apis add constraint apis_data_quality_check
  check (data_quality in (
    'ok',
    'access_restricted',
    'unreachable_documentation',
    'suspected_placeholder'
  ));

comment on column public.apis.data_quality is
  'ok                        nothing stands in the way of verifying this record.
   access_restricted         genuine as far as anyone can tell, but the provider
                             blocks access -- a paywall, a region lock, a login,
                             or anti-bot controls. Keep it and record why in
                             verification_notes. Not evidence of fabrication.
   unreachable_documentation the documentation URL is on a domain reserved by
                             RFC 2606 and can never resolve. Points at
                             fabrication; hand to manual verification for a
                             verdict before removing anything.
   suspected_placeholder     the record looks like sample data rather than a
                             real API.';

create or replace view public.v_verification_queue as
  select data_quality,
         access_scope,
         review_status,
         count(*) as records
    from public.apis
   where is_active
     and (data_quality <> 'ok' or review_status = 'Published')
   group by data_quality, access_scope, review_status
   order by data_quality, access_scope, review_status;

comment on view public.v_verification_queue is
  'What is still waiting on a person. Records already soft-deleted are excluded:
   the decision to remove one has been made and is in the audit trail.';
