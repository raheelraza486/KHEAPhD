-- 0042  Two catalogue records the composition engine misread.
--
-- 1. ESS SmartDocFlow (PINT A-NZ and EN 16931 records, migration 0041).
--    Their request body is FileRequest, a oneOf: inline base64 content
--    (filename, content) or an S3 location (bucket, key). The schema
--    extractor does not flatten oneOf, by design, so neither record stored
--    filename or content, and the PINT A-NZ record had no required request
--    field at all. Composition then passed any source into it as compatible.
--    The fields of the inline base64 branch are recorded here; it is the
--    branch the group's live calls on 7 October 2026 used. The rows were built
--    with the importer's own code (extractDocumentSchemas, schemasForOperation,
--    toFieldRows) from the same SmartDocFlow 2.0.0 document, with FileRequest
--    read as Base64ContentRequest. The schema keeps its raw extract and gains a
--    warning saying so.
--
-- 2. B2Brouter Import Invoice API (migration 0040). Its document gives the
--    request body only as application/octet-stream, which is not a format,
--    so Check 1 reported "target_no_format" for every source. B2Brouter's
--    bulk-import reference describes the same per-file pipeline as importing
--    "invoice XML files", and the group's live imports of UBL XML on
--    28 September and 7 October 2026 returned 201. input_formats becomes XML;
--    input_formats_original keeps what the document says.
--
-- Changing a record's formats or schema fields returns it to Published (the
-- verification triggers); an administrator verifies all three again.

create temporary table _0042_fields on commit drop as
select * from jsonb_to_recordset($fields0042$[{"path": "filename", "leaf_name": "filename", "leaf_name_norm": "filename", "json_type": "string", "format": null, "is_required": true, "is_array_item": false, "depth": 0, "enum_values": null, "description": "The original file name (used in logs and downloaded output).", "api_id": "10feb4e1-16d8-4f67-8463-99d44565580d"}, {"path": "content", "leaf_name": "content", "leaf_name_norm": "content", "json_type": "string", "format": "base64", "is_required": true, "is_array_item": false, "depth": 0, "enum_values": null, "description": "Base64-encoded file content.", "api_id": "10feb4e1-16d8-4f67-8463-99d44565580d"}, {"path": "pack", "leaf_name": "pack", "leaf_name_norm": "pack", "json_type": "string", "format": null, "is_required": false, "is_array_item": false, "depth": 0, "enum_values": ["billing", "selfbilling"], "description": "Which PINT A-NZ specialisation to validate against.\n\nOmit it and the server detects the pack from the document's\n`cbc:CustomizationID` (the same `starts-with` test the packs'\nown identity rules use); `details.pack_source` then reads\n`\"detected\"`.\n\nSupply it and it is an **assertion that wins**: the declared\npack runs even if the document identifies as the other one \u2014\nwhich is what a Peppol access point would report \u2014 and the\nresponse adds `details.pack_mismatch` naming both sides so\nnobody has to decode the identity rule ids by hand.\n\nDetection is only attempted when a Schematron check is\nrequested. With `checks: [\"xsd\"]` no pack is needed and\n`details.pack_source` is `\"not_required\"`.\n\nA document with no recognisable `cbc:CustomizationID` and no\n`pack` is rejected with `400` / `PACK_REQUIRED` rather than\nguessed at \u2014 guessing produces a wall of identity failures\nthat hides the real problem.", "api_id": "10feb4e1-16d8-4f67-8463-99d44565580d"}, {"path": "checks", "leaf_name": "checks", "leaf_name_norm": "checks", "json_type": "array", "format": null, "is_required": false, "is_array_item": false, "depth": 0, "enum_values": null, "description": "Which checks to run. Omit for all three. Set semantics: the\nserver runs the requested checks in the canonical order\n`xsd` \u2192 `pint-shared` \u2192 `pint-aligned` whatever order they\nwere sent in, and echoes the effective list in\n`details.checks`, so a partial run is explicit in the\nresponse. An empty list, or any unrecognised id, is `400` /\n`CHECK_UNKNOWN`.", "api_id": "10feb4e1-16d8-4f67-8463-99d44565580d"}, {"path": "checks[]", "leaf_name": "checks", "leaf_name_norm": "checks", "json_type": "string", "format": null, "is_required": false, "is_array_item": true, "depth": 0, "enum_values": ["xsd", "pint-shared", "pint-aligned"], "description": "", "api_id": "10feb4e1-16d8-4f67-8463-99d44565580d"}, {"path": "pack_version", "leaf_name": "pack_version", "leaf_name_norm": "packversion", "json_type": "string", "format": null, "is_required": false, "is_array_item": false, "depth": 0, "enum_values": null, "description": "**Reserved \u2014 sending this field returns `400` /\n`FIELD_RESERVED`.** The deployed image ships exactly one pack\nversion, which the response always states in\n`details.pack_version` and per step in `artifact.version`.\nThe field is rejected rather than ignored so that giving it\nmeaning later is a non-breaking change.", "api_id": "10feb4e1-16d8-4f67-8463-99d44565580d"}, {"path": "filename", "leaf_name": "filename", "leaf_name_norm": "filename", "json_type": "string", "format": null, "is_required": true, "is_array_item": false, "depth": 0, "enum_values": null, "description": "The original file name (used in logs and downloaded output).", "api_id": "0998d981-91d4-4eab-b952-0a0ec39d19be"}, {"path": "content", "leaf_name": "content", "leaf_name_norm": "content", "json_type": "string", "format": "base64", "is_required": true, "is_array_item": false, "depth": 0, "enum_values": null, "description": "Base64-encoded file content.", "api_id": "0998d981-91d4-4eab-b952-0a0ec39d19be"}, {"path": "profile", "leaf_name": "profile", "leaf_name_norm": "profile", "json_type": "string", "format": null, "is_required": true, "is_array_item": false, "depth": 0, "enum_values": null, "description": "Profile / variant of the Schematron pack to apply.\n- `factur-x`: `basicwl` | `en16931` | `extended`\n- `cii`: `cii-en16931` | `cii-flux2` | `cii-extended-ctc-fr`\n- `ubl`: `ubl-en16931` | `ubl-flux2` | `ubl-extended-ctc-fr`\n- `ubl-creditnote`: `ubl-creditnote-en16931` | `ubl-creditnote-flux2` | `ubl-creditnote-extended-ctc-fr`", "api_id": "0998d981-91d4-4eab-b952-0a0ec39d19be"}]$fields0042$::jsonb)
  as t(api_id uuid, path text, leaf_name text, leaf_name_norm text, json_type text, format text,
       is_required boolean, is_array_item boolean, depth integer, enum_values text[], description text);

-- ----------------------------------------------------------------- preconditions

do $$
declare pint_fields text; en_fields text;
begin
  select string_agg(f.path, ',' order by f.path) into pint_fields
    from public.api_schema s join public.api_schema_field f on f.schema_id = s.id
   where s.api_id = '10feb4e1-16d8-4f67-8463-99d44565580d' and s.direction = 'request';
  select string_agg(f.path, ',' order by f.path) into en_fields
    from public.api_schema s join public.api_schema_field f on f.schema_id = s.id
   where s.api_id = '0998d981-91d4-4eab-b952-0a0ec39d19be' and s.direction = 'request';
  if pint_fields is distinct from 'checks,checks[],pack,pack_version' or en_fields is distinct from 'profile' then
    raise exception '0042 precondition failed: ESS request fields changed (PINT %, EN 16931 %).', pint_fields, en_fields;
  end if;
  if not exists (select 1 from public.apis where id = '8c305642-44f0-4400-ae99-49801ae06131' and input_formats = array['application/octet-stream'] and is_active) then
    raise exception '0042 precondition failed: the B2Brouter import record changed.';
  end if;
end
$$;

-- ------------------------------------------------------------- ESS request fields

delete from public.api_schema_field f
 using public.api_schema s
 where f.schema_id = s.id and s.direction = 'request' and s.api_id in ('10feb4e1-16d8-4f67-8463-99d44565580d', '0998d981-91d4-4eab-b952-0a0ec39d19be');

insert into public.api_schema_field (schema_id, path, leaf_name, leaf_name_norm, json_type, format, is_required, is_array_item, depth, enum_values, description)
select s.id, n.path, n.leaf_name, n.leaf_name_norm, n.json_type, n.format, n.is_required, n.is_array_item, n.depth, n.enum_values, coalesce(n.description, '')
  from _0042_fields n
  join public.api_schema s on s.api_id = n.api_id and s.direction = 'request';

update public.api_schema
   set warnings = array_append(warnings, 'FileRequest is a oneOf (inline base64 content, or an S3 bucket and key). Migration 0042 records the fields of the inline base64 branch, which the composed processes send; the S3 branch is not recorded.')
 where direction = 'request' and api_id in ('10feb4e1-16d8-4f67-8463-99d44565580d', '0998d981-91d4-4eab-b952-0a0ec39d19be');

-- -------------------------------------------------------- B2Brouter input format

update public.apis
   set input_formats = array['XML'], updated_at = clock_timestamp()
 where id = '8c305642-44f0-4400-ae99-49801ae06131';

-- --------------------------------------------------------------------- audit

insert into public.api_audit_events (api_id, api_name, company_name, action, actor_name, actor_user_id, details)
select id, api_name, company_name, 'edit', 'System migration', null,
       case when id = '8c305642-44f0-4400-ae99-49801ae06131'
         then 'Input format set to XML by migration 0042: the document gives only application/octet-stream; B2Brouter imports invoice XML files, and the group''s UBL XML imports on 28 Sep and 7 Oct 2026 returned 201.'
         else 'Request fields recorded by migration 0042 for the inline base64 branch of FileRequest (filename, content), which the schema extractor does not flatten.'
       end
  from public.apis where id in ('10feb4e1-16d8-4f67-8463-99d44565580d', '0998d981-91d4-4eab-b952-0a0ec39d19be', '8c305642-44f0-4400-ae99-49801ae06131');

-- ------------------------------------------------------------------ postcondition

do $$
declare n integer;
begin
  select count(*) into n
    from public.api_schema s join public.api_schema_field f on f.schema_id = s.id
   where s.direction = 'request' and s.api_id in ('10feb4e1-16d8-4f67-8463-99d44565580d', '0998d981-91d4-4eab-b952-0a0ec39d19be') and f.path in ('filename', 'content') and f.is_required;
  if n <> 4 then raise exception '0042 postcondition failed: % required filename/content fields.', n; end if;
end
$$;
