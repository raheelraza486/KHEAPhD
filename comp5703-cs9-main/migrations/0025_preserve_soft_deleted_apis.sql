-- API removal is intentionally disabled in the current application UI, but an
-- existing soft deletion remains a catalogue decision: the API is in scope and
-- may be repaired later, while its reason and provenance remain available.
-- Do not restore those rows automatically and do not hard-delete their schema.

comment on column public.apis.is_active is
  'False is a reversible soft deletion for an in-scope API whose missing or unconfirmed information may be repaired. Out-of-scope, fabricated, and test records may be hard-deleted only after a persistent delete audit tombstone is written.';

comment on column public.app_user.role is
  'viewer — legacy account; may edit submissions it already owns.
   publisher — submit APIs and edit own submissions at any review status.
   admin — manage and verify all APIs. API deletion through the application is currently disabled.';

