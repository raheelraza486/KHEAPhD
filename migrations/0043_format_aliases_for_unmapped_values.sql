-- 0043  Aliases for the four format values format_alias did not know.
--
-- scripts/check.sh reported four values in apis.input_formats/output_formats
-- with no alias, so Check 1 listed them as unrecognised. Each is a real value
-- the source documents state, not a writer bug, and each gets a canonical name
-- of its own; nothing is merged into an existing format, and no record is
-- changed (changing formats would return verified records to Published).
--
--   No request body           32 records, input. Written by the 31 Aug - 12 Sep
--                             imports for operations without a body; none has a
--                             request schema, so Check 1 does not vote on them
--                             (manual 1.2). Not a format; recorded as itself.
--   multipart/form-data        4 records, input (Peppol Validator, Mailgun,
--                             Nanonets, e-invoice conversion): a file upload
--                             envelope, like application/x-www-form-urlencoded.
--   text/plain                 2 records, output (EzzyBills): the documents list
--                             text/plain next to application/json for the same
--                             response schema.
--   application/octet-stream   1 record, input (beliq convertInvoice, which also
--                             lists XML and PDF): raw bytes of an unstated type.

insert into public.format_alias (alias, canonical, note) values
  ('No request body', 'No request body', 'canonical; not a format: the operation takes no request body'),
  ('Multipart form data', 'Multipart form data', 'canonical'),
  ('multipart/form-data', 'Multipart form data', 'media type written where a format name belongs; same format'),
  ('Plain text', 'Plain text', 'canonical'),
  ('text/plain', 'Plain text', 'media type written where a format name belongs; same format'),
  ('Binary', 'Binary', 'canonical; raw bytes of an unstated type'),
  ('application/octet-stream', 'Binary', 'media type written where a format name belongs; same format')
on conflict (alias) do nothing;

do $$
declare unmapped integer;
begin
  select count(*) into unmapped from public.v_unmapped_formats;
  if unmapped <> 0 then
    raise exception '0043 postcondition failed: % format value(s) still have no alias.', unmapped;
  end if;
end
$$;
