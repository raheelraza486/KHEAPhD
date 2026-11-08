-- 0037  Three media types the format table never learned
--
-- v_unmapped_formats has been listing them, and scripts/check.sh has been
-- failing on them, since the Transformation and Validation APIs were added:
--
--   application/xml    7 records
--   application/pdf    4 records
--   text/xml           1 record
--
-- This is no longer only untidy data. Check 1 reads a value it cannot map as
-- no format at all, so every pair into or out of these APIs stops at
-- source_no_format / target_no_format. They are the APIs a real integration
-- case study needs -- a generator that returns UBL XML, a validator that takes
-- it -- and on 25 September not one Transformation → Validation → Communication
-- chain through them could pass. With these three rows, NormAPI Generate an
-- invoice → Peppol Validator → Serbia SEF Upload Sales Invoice UBL passes.
--
-- Rows only, unlike 0021, which also rewrote the records' own columns. Every
-- record carrying these values is Verified, and since 0023 a change to
-- input_formats or output_formats returns a record to the verification queue.
-- Rewriting six verified records to change a spelling would undo verification
-- nobody asked to undo. The checks map through format_alias when they read,
-- so the rows alone are enough, and the records keep what their sources say.
--
-- Not mapped here: multipart/form-data and application/octet-stream, which
-- describe how a file is sent rather than what it is; and "No request body",
-- which states that an operation takes no body rather than naming a format.

insert into public.format_alias (alias, canonical, note) values
  ('application/xml', 'XML', 'media type written where a format name belongs; same format'),
  ('text/xml',        'XML', 'media type written where a format name belongs; same format'),
  ('application/pdf', 'PDF', 'media type written where a format name belongs; same format')
on conflict (alias) do nothing;
